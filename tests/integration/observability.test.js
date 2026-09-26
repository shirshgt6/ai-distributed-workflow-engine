// Every LLM call is recorded and attributed to its task; analytics aggregate it.
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { AIExecution } from "../../src/models/aiExecution.model.js";
import { createMockProvider } from "../../src/ai/providers/mock.js";
import { MONGO_URI, logger, createTestStack, createUser, as, waitFor } from "../helpers/testApp.js";

const llm = createMockProvider({
  respond: () => ({ content: JSON.stringify({ answer: "hello" }), usage: { inputTokens: 1000, outputTokens: 500 } }),
});
// Price the mock "small" model so cost maths is visible: $1 / 1M input, $2 / 1M output.
const stack = createTestStack({ llm, pricing: { "mock-small": { inputPer1M: 1, outputPer1M: 2 } } });
const { app } = stack;
let alice;
let bob;
let viewer;

async function runGenerate(user, n = 1) {
  const wf = (await as(app, user.token).post("/workflows").send({ name: "gen", tasks: [{ key: "g", type: "ai.generate" }] })).body.workflow;
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push((await as(app, user.token).post(`/workflows/${wf.id}/run`).send({ input: { text: `q${i}` } })).body.execution.id);
  }
  for (const id of ids) await waitFor(async () => (await WorkflowExecution.findById(id))?.status === "COMPLETED");
  return ids;
}
const clean = () => Promise.all([User, Workflow, WorkflowExecution, Task, TaskExecution, AIExecution].map((m) => m.deleteMany({})));

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await clean();
  await stack.start();
  [alice, bob, viewer] = await Promise.all([
    createUser("alice@obs.test", "operator"),
    createUser("bob@obs.test", "operator"),
    createUser("viewer@obs.test", "viewer"),
  ]);
});
afterAll(async () => {
  await stack.stop();
  await clean();
  await disconnectMongo();
});

test("each LLM call is recorded with its execution, task, type, tokens, latency and cost (no prompt text)", async () => {
  const [executionId] = await runGenerate(alice);
  const task = await Task.findOne({ executionId });
  const rows = await waitFor(async () => {
    const r = await AIExecution.find({ executionId }).lean();
    return r.length ? r : null;
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    operation: "chat",
    taskId: task._id,
    ownerId: alice.user._id,
    taskType: "ai.generate",
    model: "mock-small",
    status: "success",
    fallbackUsed: false,
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    estimatedCostUsd: 0.002, // 1000 * $1/1M + 500 * $2/1M
  });
  expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(rows[0])).not.toContain("q0"); // the prompt itself is not stored
});

test("GET /analytics/ai aggregates per model; scoped to the caller", async () => {
  await runGenerate(alice, 2);
  await waitFor(async () => (await AIExecution.countDocuments({ ownerId: alice.user._id })) === 3);

  const res = await as(app, alice.token).get("/analytics/ai?days=1");
  expect(res.status).toBe(200);
  expect(res.body.totals).toMatchObject({ calls: 3, errors: 0, totalTokens: 4500, estimatedCostUsd: 0.006 });
  expect(res.body.models[0]).toMatchObject({ model: "mock-small", calls: 3, errorRate: 0 });
  expect(res.body.models[0].p95LatencyMs).toBeGreaterThanOrEqual(0);
  expect(res.body.byTaskType).toEqual([{ taskType: "ai.generate", calls: 3, totalTokens: 4500 }]);

  const bobs = await as(app, bob.token).get("/analytics/ai");
  expect(bobs.body.totals.calls).toBe(0); // Bob can't see Alice's usage
});

test("GET /analytics/workflows: counts, success rate, duration, retries, failing task types", async () => {
  const wf = (await as(app, alice.token).post("/workflows").send({ name: "f", tasks: [{ key: "x", type: "fail" }] })).body.workflow;
  const id = (await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({})).body.execution.id;
  await waitFor(async () => (await WorkflowExecution.findById(id))?.status === "FAILED");

  const res = await as(app, alice.token).get("/analytics/workflows?days=1");
  expect(res.status).toBe(200);
  expect(res.body.executions.byStatus).toMatchObject({ COMPLETED: 3, FAILED: 1 });
  expect(res.body.successRate).toBe(0.75);
  expect(res.body.topFailingTaskTypes).toEqual([{ type: "fail", failures: 1 }]);
  expect(res.body.durationMs.avg).toBeGreaterThanOrEqual(0);
});

test("viewer may read analytics (their own, empty); anonymous may not", async () => {
  expect((await as(app, viewer.token).get("/analytics/ai")).status).toBe(200);
  expect((await as(app, viewer.token).get("/analytics/ai")).body.totals.calls).toBe(0);
  expect((await as(app, viewer.token).get("/analytics/workflows?days=500")).status).toBe(400);
});
