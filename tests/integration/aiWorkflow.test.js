// AI tasks inside real workflow runs (mock LLM): classify -> route -> generate.
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { createMockProvider } from "../../src/ai/providers/mock.js";
import { ProviderError } from "../../src/ai/providers/errors.js";
import { MONGO_URI, logger, createTestStack, createUser, as, waitFor, TEST_MODELS } from "../helpers/testApp.js";

// A scripted "LLM": answers depend on which prompt it receives.
let llmDown = 0; // number of upcoming chat calls that fail with a retryable error
const llm = createMockProvider({
  respond: (req) => {
    if (llmDown > 0) {
      llmDown -= 1;
      return new ProviderError("ollama timed out", { provider: "ollama", retryable: true });
    }
    const system = req.messages[0].content;
    const user = req.messages[1].content;
    if (system.includes("You classify")) {
      const hard = user.includes("prove");
      return JSON.stringify({
        taskType: hard ? "reasoning" : "question_answering",
        complexity: hard ? "high" : "low",
        requiresRAG: user.includes("policy"),
        requiresAgent: false,
        recommendedModel: hard ? "large" : "small",
        rationale: "scripted",
      });
    }
    return JSON.stringify({ answer: `answer from ${req.model}` });
  },
});
const stack = createTestStack({ llm });
const { app } = stack;
let alice;

const pipeline = [
  { key: "classify", type: "ai.classify" },
  { key: "route", type: "ai.route", dependsOn: ["classify"] },
  { key: "answer", type: "ai.generate", dependsOn: ["route"], retryPolicy: { maxAttempts: 3, baseDelayMs: 10 } },
];

async function run(text) {
  const wf = (await as(app, alice.token).post("/workflows").send({ name: "ai", tasks: pipeline })).body.workflow;
  const id = (await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({ input: { text } })).body.execution.id;
  return waitFor(async () => {
    const body = (await as(app, alice.token).get(`/executions/${id}`)).body;
    return ["COMPLETED", "FAILED"].includes(body.execution.status) ? body : null;
  });
}
const byKey = (tasks) => Object.fromEntries(tasks.map((t) => [t.key, t]));

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await Promise.all([User, Workflow, WorkflowExecution, Task, TaskExecution].map((m) => m.deleteMany({})));
  await stack.start();
  alice = await createUser("alice@ai.test", "operator");
});
afterAll(async () => {
  await stack.stop();
  await Promise.all([User, Workflow, WorkflowExecution, Task, TaskExecution].map((m) => m.deleteMany({})));
  await disconnectMongo();
});

test("simple request: classified low -> routed to the SMALL model -> answered by it", async () => {
  const { execution, tasks } = await run("What time zone is IST?");
  expect(execution.status).toBe("COMPLETED");
  const t = byKey(tasks);
  expect(t.classify.output).toMatchObject({ source: "llm", classification: { complexity: "low" } });
  expect(t.route.output.route).toMatchObject({ mode: "direct", tier: "small", model: TEST_MODELS.small });
  expect(t.answer.output).toMatchObject({ answer: `answer from ${TEST_MODELS.small}`, model: TEST_MODELS.small });
});

test("hard request: routed to the LARGE model, which is what actually answers", async () => {
  const { tasks } = await run("prove that the algorithm terminates");
  const t = byKey(tasks);
  expect(t.route.output.route).toMatchObject({ tier: "large", rule: "high-complexity" });
  expect(t.answer.output.model).toBe(TEST_MODELS.large);
});

test("route reuses the parent's classification (no second classifier call)", async () => {
  const before = llm.calls.length;
  await run("hello");
  const classifierCalls = llm.calls.slice(before).filter((c) => c.messages[0].content.includes("You classify"));
  expect(classifierCalls).toHaveLength(1);
});

test("a knowledge request routed to RAG can't be answered by ai.generate (fails clearly, no retry)", async () => {
  const { execution, tasks } = await run("what is our refund policy?");
  expect(execution.status).toBe("FAILED");
  expect(byKey(tasks).answer).toMatchObject({ status: "FAILED", attempt: 1 });
  expect(byKey(tasks).answer.error).toMatch(/routed to "rag"/);
});

test("LLM timeout on generate -> task retried with backoff -> succeeds", async () => {
  const wf = (await as(app, alice.token).post("/workflows").send({ name: "gen", tasks: [{ key: "answer", type: "ai.generate", retryPolicy: { maxAttempts: 3, baseDelayMs: 10 } }] })).body.workflow;
  llmDown = 1;
  const id = (await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({ input: { text: "hi" } })).body.execution.id;
  const body = await waitFor(async () => {
    const b = (await as(app, alice.token).get(`/executions/${id}`)).body;
    return b.execution.status === "COMPLETED" ? b : null;
  });
  expect(body.tasks[0]).toMatchObject({ status: "COMPLETED", attempt: 2 });
});
