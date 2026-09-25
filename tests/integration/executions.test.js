// End-to-end: HTTP -> engine -> Redis queue -> worker -> real handlers -> MongoDB.
import request from "supertest";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { MONGO_URI, logger, createTestStack, createUser, as, waitFor } from "../helpers/testApp.js";

const stack = createTestStack({ concurrency: 4 });
const { app } = stack;

let alice; // operator
let bob; // operator
let victor; // viewer

async function clean() {
  await Promise.all(
    [User, Workflow, WorkflowExecution, Task, TaskExecution].map((m) => m.deleteMany({}))
  );
}

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await stack.start();
  await clean();
  await Promise.all([User.init(), Task.init(), TaskExecution.init()]);
  [alice, bob, victor] = await Promise.all([
    createUser("alice@ex.test", "operator"),
    createUser("bob@ex.test", "operator"),
    createUser("victor@ex.test", "viewer"),
  ]);
});

afterAll(async () => {
  await stack.stop();
  await clean();
  await disconnectMongo();
});

async function createWorkflow(token, tasks, name = "wf") {
  const res = await as(app, token).post("/workflows").send({ name, tasks });
  expect(res.status).toBe(201);
  return res.body.workflow;
}

async function runAndWait(token, workflowId, input = {}) {
  const run = await as(app, token).post(`/workflows/${workflowId}/run`).send({ input });
  expect(run.status).toBe(202);
  const executionId = run.body.execution.id;
  expect(run.headers.location).toBe(`/executions/${executionId}`);
  return waitFor(async () => {
    const res = await as(app, token).get(`/executions/${executionId}`);
    return ["COMPLETED", "FAILED"].includes(res.body.execution.status) ? res.body : null;
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const byKey = (tasks) => Object.fromEntries(tasks.map((t) => [t.key, t]));

test("diamond runs end to end: B and C overlap in time, D runs after both, data flows", async () => {
  const wf = await createWorkflow(alice.token, [
    { key: "A", type: "echo", config: { step: "A" } },
    { key: "B", type: "delay", dependsOn: ["A"], config: { ms: 250 } },
    { key: "C", type: "delay", dependsOn: ["A"], config: { ms: 250 } },
    { key: "D", type: "echo", dependsOn: ["B", "C"] },
  ]);

  const { execution, tasks } = await runAndWait(alice.token, wf.id, { invoice: 7 });

  expect(execution).toMatchObject({ status: "COMPLETED", pendingTasks: 0, taskCount: 4, workflowVersion: 1 });
  const t = byKey(tasks);
  for (const key of ["A", "B", "C", "D"]) expect(t[key].status).toBe("COMPLETED");

  const at = (key, field) => new Date(t[key][field]).getTime();
  // PARALLELISM: each of B/C started before the other finished.
  expect(at("B", "startedAt")).toBeLessThan(at("C", "completedAt"));
  expect(at("C", "startedAt")).toBeLessThan(at("B", "completedAt"));
  // DEPENDENCIES: D started only after both parents completed.
  expect(at("D", "startedAt")).toBeGreaterThanOrEqual(Math.max(at("B", "completedAt"), at("C", "completedAt")));
  // DATA FLOW: D (echo) received its parents' outputs and the run input.
  expect(t.D.output).toEqual({ config: {}, input: { invoice: 7 }, parents: { B: { waitedMs: 250 }, C: { waitedMs: 250 } } });
});

test("failure is fail-fast: execution FAILED, downstream CANCELLED", async () => {
  const wf = await createWorkflow(alice.token, [
    { key: "A", type: "noop" },
    { key: "B", type: "delay", dependsOn: ["A"], config: { ms: 150 } },
    { key: "C", type: "fail", dependsOn: ["A"], config: { message: "card declined" } },
    { key: "D", type: "noop", dependsOn: ["B", "C"] },
  ]);

  const { execution } = await runAndWait(alice.token, wf.id);
  expect(execution.status).toBe("FAILED");
  expect(execution.error).toBe('Task "C" failed: card declined');

  // B was already running: let it finish, then check final task states.
  const final = await waitFor(async () => {
    const body = (await as(app, alice.token).get(`/executions/${execution.id}`)).body;
    return body.execution.pendingTasks === 0 ? body : null;
  });
  const t = byKey(final.tasks);
  expect([t.A.status, t.B.status, t.C.status, t.D.status]).toEqual(["COMPLETED", "COMPLETED", "FAILED", "CANCELLED"]);
  expect(t.C.error).toBe("card declined");
});

test("a handler exceeding its timeout is retried (timeouts are transient), then dead-lettered", async () => {
  const wf = await createWorkflow(alice.token, [
    { key: "slow", type: "delay", config: { ms: 2000 }, timeoutMs: 100, retryPolicy: { maxAttempts: 2, baseDelayMs: 10 } },
  ]);
  const { execution, tasks } = await runAndWait(alice.token, wf.id);
  expect(execution.status).toBe("FAILED");
  expect(tasks[0]).toMatchObject({ status: "DEAD_LETTER", attempt: 2 });
  expect(tasks[0].error).toMatch(/timed out after 100ms/);
});

test("a flaky task succeeds on its 3rd attempt and the run completes", async () => {
  const wf = await createWorkflow(alice.token, [
    { key: "flaky", type: "flaky", config: { failTimes: 2 }, retryPolicy: { maxAttempts: 3, baseDelayMs: 10 } },
    { key: "after", type: "echo", dependsOn: ["flaky"] },
  ]);
  const { execution, tasks } = await runAndWait(alice.token, wf.id);
  expect(execution.status).toBe("COMPLETED");
  const t = byKey(tasks);
  expect(t.flaky).toMatchObject({ status: "COMPLETED", attempt: 3, output: { succeededOnAttempt: 3 } });
  expect(t.after.output.parents).toEqual({ flaky: { succeededOnAttempt: 3 } });
});

describe("idempotent POST /workflows/:id/run", () => {
  let wf;
  beforeAll(async () => {
    wf = await createWorkflow(alice.token, [{ key: "A", type: "noop" }], "idem");
  });
  const runWithKey = (key, input = {}, token = alice.token) =>
    as(app, token).post(`/workflows/${wf.id}/run`).set("Idempotency-Key", key).send({ input });

  test("same key + same request -> the SAME execution, flagged as a replay", async () => {
    const first = await runWithKey("order-12345-click", { order: 1 });
    const again = await runWithKey("order-12345-click", { order: 1 });
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(again.body.execution.id).toBe(first.body.execution.id);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(await WorkflowExecution.countDocuments({ idempotencyKey: "order-12345-click" })).toBe(1);
  });

  test("key order inside the input doesn't matter (canonical hash)", async () => {
    const a = await runWithKey("order-canon-1", { x: 1, y: 2 });
    const b = await runWithKey("order-canon-1", { y: 2, x: 1 });
    expect(b.body.execution.id).toBe(a.body.execution.id);
  });

  test("same key + DIFFERENT request -> 422, nothing new created", async () => {
    await runWithKey("order-777-click", { order: 7 });
    const res = await runWithKey("order-777-click", { order: 8 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await WorkflowExecution.countDocuments({ idempotencyKey: "order-777-click" })).toBe(1);
  });

  test("RACE: 5 simultaneous requests with one key -> exactly ONE execution", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => runWithKey("double-click-race", { n: 1 })));
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(new Set(results.map((r) => r.body.execution.id)).size).toBe(1);
    expect(await WorkflowExecution.countDocuments({ idempotencyKey: "double-click-race" })).toBe(1);
  });

  test("keys are per user: another user's identical key is independent", async () => {
    const wfBob = await createWorkflow(bob.token, [{ key: "A", type: "noop" }], "bob-idem");
    const aliceRun = await runWithKey("shared-key-123");
    const bobRun = await as(app, bob.token).post(`/workflows/${wfBob.id}/run`).set("Idempotency-Key", "shared-key-123").send({});
    expect(bobRun.status).toBe(202);
    expect(bobRun.body.execution.id).not.toBe(aliceRun.body.execution.id);
  });

  test("malformed key -> 400; no key -> every call is a new run", async () => {
    expect((await runWithKey("short")).status).toBe(400);
    const r1 = await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({});
    const r2 = await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({});
    expect(r1.body.execution.id).not.toBe(r2.body.execution.id);
  });
});

test("editing the workflow does not change a run already created (snapshot)", async () => {
  const wf = await createWorkflow(alice.token, [{ key: "A", type: "delay", config: { ms: 200 } }]);
  const run = await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({});
  await as(app, alice.token)
    .put(`/workflows/${wf.id}`)
    .send({ name: "edited", tasks: [{ key: "Z", type: "noop" }], version: 1 });

  const done = await waitFor(async () => {
    const body = (await as(app, alice.token).get(`/executions/${run.body.execution.id}`)).body;
    return body.execution.status === "COMPLETED" ? body : null;
  });
  expect(done.execution.workflowVersion).toBe(1);
  expect(done.tasks.map((t) => t.key)).toEqual(["A"]);
});

describe("pause / resume / cancel over HTTP", () => {
  test("cancel a running execution: 200, tasks cancelled, a second cancel is 409", async () => {
    const wf = await createWorkflow(alice.token, [
      { key: "slow", type: "delay", config: { ms: 3000 } },
      { key: "after", type: "noop", dependsOn: ["slow"] },
    ]);
    const run = await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({});
    const id = run.body.execution.id;
    await waitFor(async () => (await Task.findOne({ executionId: id, key: "slow" }))?.status === "RUNNING");

    const res = await as(app, alice.token).post(`/executions/${id}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body.execution.status).toBe("CANCELLED");
    const tasks = (await as(app, alice.token).get(`/executions/${id}`)).body.tasks;
    expect(tasks.map((t) => t.status)).toEqual(["CANCELLED", "CANCELLED"]);

    const again = await as(app, alice.token).post(`/executions/${id}/cancel`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("INVALID_STATE");
  });

  test("pause then resume over HTTP", async () => {
    const wf = await createWorkflow(alice.token, [
      { key: "a", type: "delay", config: { ms: 200 } },
      { key: "b", type: "noop", dependsOn: ["a"] },
    ]);
    const id = (await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({})).body.execution.id;
    expect((await as(app, alice.token).post(`/executions/${id}/pause`).send({})).body.execution.status).toBe("PAUSED");
    await sleepMs(400);
    const paused = (await as(app, alice.token).get(`/executions/${id}`)).body;
    expect(paused.tasks.map((t) => t.status)).toEqual(["COMPLETED", "PENDING"]); // b not started while paused
    expect((await as(app, alice.token).post(`/executions/${id}/resume`).send({})).status).toBe(200);
    const done = await waitFor(async () => {
      const body = (await as(app, alice.token).get(`/executions/${id}`)).body;
      return body.execution.status === "COMPLETED" ? body : null;
    });
    expect(done.tasks.map((t) => t.status)).toEqual(["COMPLETED", "COMPLETED"]);
  });

  test("another operator cannot cancel someone else's run (404); viewer cannot (403)", async () => {
    const wf = await createWorkflow(alice.token, [{ key: "a", type: "delay", config: { ms: 500 } }]);
    const id = (await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({})).body.execution.id;
    expect((await as(app, bob.token).post(`/executions/${id}/cancel`).send({})).status).toBe(404);
    expect((await as(app, victor.token).post(`/executions/${id}/cancel`).send({})).status).toBe(403);
  });
});

describe("authorization", () => {
  let wf;
  beforeAll(async () => {
    wf = await createWorkflow(alice.token, [{ key: "A", type: "noop" }], "alice-only");
  });

  test("viewer cannot run workflows (403)", async () => {
    expect((await as(app, victor.token).post(`/workflows/${wf.id}/run`).send({})).status).toBe(403);
  });

  test("another operator cannot run someone else's workflow (404)", async () => {
    expect((await as(app, bob.token).post(`/workflows/${wf.id}/run`).send({})).status).toBe(404);
  });

  test("another operator cannot read someone else's execution (404)", async () => {
    const run = await as(app, alice.token).post(`/workflows/${wf.id}/run`).send({});
    expect((await as(app, bob.token).get(`/executions/${run.body.execution.id}`)).status).toBe(404);
    expect((await as(app, alice.token).get(`/executions/${run.body.execution.id}`)).status).toBe(200);
  });

  test("anonymous -> 401", async () => {
    expect((await request(app).post(`/workflows/${wf.id}/run`).send({})).status).toBe(401);
  });
});
