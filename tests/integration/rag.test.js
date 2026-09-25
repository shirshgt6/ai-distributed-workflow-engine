// RAG end to end with REAL Qdrant + MongoDB and a scripted mock LLM
// (bag-of-words embeddings). Requires: npm run infra:up
import request from "supertest";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { KnowledgeDocument, KnowledgeChunk } from "../../src/models/knowledge.model.js";
import { createMockProvider } from "../../src/ai/providers/mock.js";
import { NO_ANSWER } from "../../src/ai/rag/pipeline.js";
import { MONGO_URI, logger, createTestStack, createUser, as, waitFor } from "../helpers/testApp.js";

const REFUND_DOC = `Refund policy.
Customers can request a refund within 30 days of purchase. Refunds go back to the original payment method within 5 business days.

Shipping policy.
Orders ship within 2 business days. Express shipping costs extra and arrives next day.`;

// Scripted LLM. For RAG prompts it cites a source id taken from the context,
// unless told to hallucinate.
let ragReply = null; // override per test: (req, i) => string
const llm = createMockProvider({
  respond: (req, i) => {
    if (req.messages[0].content.includes("ONLY the numbered sources")) {
      if (ragReply) return ragReply(req, i);
      return JSON.stringify({ answer: "Within 30 days of purchase.", citations: ["S1"], grounded: true });
    }
    return "{}";
  },
});
const stack = createTestStack({ llm });
const { app, rag } = stack;
let alice;
let bob;
let viewer;

async function upload(token, content = REFUND_DOC, title = "Policies") {
  return as(app, token).post("/documents").send({ title, content });
}
const clean = () => Promise.all([User, Workflow, WorkflowExecution, Task, TaskExecution, KnowledgeDocument, KnowledgeChunk].map((m) => m.deleteMany({})));

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await clean();
  await KnowledgeDocument.init();
  await stack.start();
  [alice, bob, viewer] = await Promise.all([
    createUser("alice@rag.test", "operator"),
    createUser("bob@rag.test", "operator"),
    createUser("viewer@rag.test", "viewer"),
  ]);
});
beforeEach(async () => {
  ragReply = null;
  for (const d of await KnowledgeDocument.find({})) await rag.deleteDocument({ ownerScopeFilter: {}, documentId: d._id });
});
afterAll(async () => {
  await stack.stop();
  await clean();
  await disconnectMongo();
});

describe("ingestion", () => {
  test("upload -> cleaned, chunked, embedded, stored in MongoDB AND Qdrant -> READY", async () => {
    const res = await upload(alice.token);
    expect(res.status).toBe(201);
    expect(res.body.document).toMatchObject({ title: "Policies", status: "READY", embeddingModel: "mock-embed", vectorDims: 64 });
    const chunks = await KnowledgeChunk.find({ documentId: res.body.document.id }).sort({ index: 1 });
    expect(chunks.length).toBe(res.body.document.chunkCount);
    const hits = await rag.retrieve({ ownerId: alice.user._id, query: "refund within days", k: 10 });
    expect(new Set(hits.map((h) => h.pointId))).toEqual(new Set(chunks.map((c) => c.pointId).filter((id) => hits.some((h) => h.pointId === id))));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("re-uploading the same content -> 409 DUPLICATE_DOCUMENT", async () => {
    await upload(alice.token);
    const again = await upload(alice.token, REFUND_DOC.replace("Refund", "Refund  ")); // same after cleaning
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("DUPLICATE_DOCUMENT");
  });

  test("embedding failure mid-ingest -> FAILED, no chunks, nothing searchable", async () => {
    const originalEmbed = llm.embed;
    llm.embed = async () => {
      throw new Error("embedding model crashed");
    };
    const res = await upload(alice.token, "Totally unique content about quantum espresso machines.", "Broken");
    llm.embed = originalEmbed;
    expect(res.status).toBe(500);
    const doc = await KnowledgeDocument.findOne({ title: "Broken" });
    expect(doc).toMatchObject({ status: "FAILED", error: "embedding model crashed" });
    expect(await KnowledgeChunk.countDocuments({ documentId: doc._id })).toBe(0);
  });

  test("viewer can't upload (403); anonymous (401)", async () => {
    expect((await upload(viewer.token)).status).toBe(403);
    expect((await request(app).post("/documents").send({ title: "x", content: REFUND_DOC })).status).toBe(401);
  });
});

describe("retrieval", () => {
  test("the most relevant chunk ranks first", async () => {
    await upload(alice.token);
    const res = await as(app, alice.token).post("/knowledge/search").send({ query: "express shipping next day", topK: 3 });
    expect(res.status).toBe(200);
    expect(res.body.results[0].text).toMatch(/Express shipping/);
    expect(res.body.results[0].score).toBeGreaterThan(res.body.results.at(-1).score - 1e-9);
  });

  test("TENANT ISOLATION: Bob's searches never return Alice's chunks (filter inside the Qdrant query)", async () => {
    await upload(alice.token);
    const res = await as(app, bob.token).post("/knowledge/search").send({ query: "refund within 30 days" });
    expect(res.body.results).toEqual([]);
    expect((await as(app, bob.token).get("/documents")).body.documents).toEqual([]);
  });

  test("deleting a document removes its vectors", async () => {
    const doc = (await upload(alice.token)).body.document;
    expect((await as(app, alice.token).delete(`/documents/${doc.id}`)).status).toBe(204);
    const res = await as(app, alice.token).post("/knowledge/search").send({ query: "refund" });
    expect(res.body.results).toEqual([]);
    expect(await KnowledgeChunk.countDocuments({ documentId: doc.id })).toBe(0);
  });

  test("Bob can't delete Alice's document (404)", async () => {
    const doc = (await upload(alice.token)).body.document;
    expect((await as(app, bob.token).delete(`/documents/${doc.id}`)).status).toBe(404);
  });
});

describe("grounded answers with citations", () => {
  test("answer cites a retrieved source, mapped back to document + chunk", async () => {
    await upload(alice.token);
    const r = await rag.answer({ ownerId: alice.user._id, question: "How many days do I have to request a refund?", model: "mock-small" });
    expect(r).toMatchObject({ answer: "Within 30 days of purchase.", grounded: true });
    expect(r.citations[0]).toMatchObject({ id: "S1", title: "Policies" });
    expect(r.retrieved).toBeGreaterThan(0);
    // The context sent to the model was delimited as untrusted data.
    const last = llm.calls.filter((c) => c.type === "chat").at(-1);
    expect(last.messages[1].content).toMatch(/^<document>/);
  });

  test("HALLUCINATED citation (S9, never retrieved) fails validation -> repaired", async () => {
    await upload(alice.token);
    let ragCalls = 0;
    ragReply = () => {
      ragCalls += 1;
      // 1st answer cites a source that was never retrieved; the repair fixes it.
      return JSON.stringify({ answer: "30 days", citations: [ragCalls === 1 ? "S9" : "S1"], grounded: true });
    };
    const r = await rag.answer({ ownerId: alice.user._id, question: "refund days?", model: "mock-small" });
    expect(r.citations.map((c) => c.id)).toEqual(["S1"]);
    expect(ragCalls).toBe(2); // bad answer + repaired answer
    const repair = llm.calls.filter((c) => c.type === "chat").at(-1).messages.at(-1).content;
    expect(repair).toMatch(/citations/); // the repair turn named the invalid field
  });

  test("nothing relevant retrieved -> fixed 'not enough information', and the LLM is NOT called", async () => {
    const before = llm.calls.filter((c) => c.type === "chat").length;
    const r = await rag.answer({ ownerId: bob.user._id, question: "refund?", model: "mock-small" }); // Bob has no docs
    expect(r).toMatchObject({ answer: NO_ANSWER, grounded: false, citations: [], retrieved: 0 });
    expect(llm.calls.filter((c) => c.type === "chat").length).toBe(before);
  });

  test("model says the sources don't contain it -> no answer is invented", async () => {
    await upload(alice.token);
    ragReply = () => JSON.stringify({ answer: "Probably 90 days", citations: [], grounded: false });
    const r = await rag.answer({ ownerId: alice.user._id, question: "What is the warranty on refunds?", model: "mock-small" });
    expect(r).toMatchObject({ answer: NO_ANSWER, grounded: false, citations: [] });
  });
});

test("ai.rag as a workflow task: answers from the RUN OWNER's knowledge base", async () => {
  await upload(alice.token);
  const wf = (await as(app, alice.token).post("/workflows").send({ name: "rag", tasks: [{ key: "ask", type: "ai.rag" }] })).body.workflow;
  const id = (await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({ input: { text: "refund within how many days?" } })).body.execution.id;
  const body = await waitFor(async () => {
    const b = (await as(app, alice.token).get(`/executions/${id}`)).body;
    return b.execution.status === "COMPLETED" ? b : null;
  });
  expect(body.tasks[0].output).toMatchObject({ grounded: true, citations: [{ id: "S1", title: "Policies" }] });
});
