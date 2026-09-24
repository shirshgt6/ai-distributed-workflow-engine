// Engine tests against real MongoDB (transactions need the replica set).
// The executor is replaced by a recorder, so each test drives task
// completion by hand and can force exact interleavings.
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { createEngine } from "../../src/workflow/engine.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { EXECUTION_STATUS as E, TASK_STATUS as T } from "../../src/workflow/states.js";
import { MONGO_URI, logger } from "../helpers/testApp.js";

let enqueued = [];
const engine = createEngine({
  models: { WorkflowExecution, Task, TaskExecution },
  enqueue: (item) => {
    enqueued.push(item.key);
  },
  logger,
});

const ownerId = new mongoose.Types.ObjectId();
const def = (key, ...dependsOn) => ({
  key,
  type: "noop",
  dependsOn,
  config: {},
  retryPolicy: { maxAttempts: 3, baseDelayMs: 1000 },
  timeoutMs: 30000,
});
const workflowOf = (...tasks) => ({ _id: new mongoose.Types.ObjectId(), ownerId, version: 1, tasks });
const diamond = () => workflowOf(def("A"), def("B", "A"), def("C", "A"), def("D", "B", "C"));

/** Plain {status, pendingTasks} so a failing assertion prints a readable diff. */
async function executionState(id) {
  const e = await WorkflowExecution.findById(id).lean();
  return { status: e.status, pendingTasks: e.pendingTasks };
}

async function taskByKey(executionId, key) {
  return Task.findOne({ executionId, key });
}

/** Play the executor's role: claim a QUEUED task (-> RUNNING). */
async function start(executionId, key) {
  const task = await taskByKey(executionId, key);
  const claimed = await engine.startTask(task._id, "test-worker");
  return claimed.task; // carries the fresh leaseToken
}

async function startAndComplete(executionId, key, output = { from: key }) {
  const task = await start(executionId, key);
  return engine.completeTask({ taskId: task._id, leaseToken: task.leaseToken, output });
}

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await Promise.all([WorkflowExecution.init(), Task.init(), TaskExecution.init()]);
});

beforeEach(async () => {
  enqueued = [];
  await Promise.all([WorkflowExecution.deleteMany({}), Task.deleteMany({}), TaskExecution.deleteMany({})]);
});

afterAll(async () => {
  await Promise.all([WorkflowExecution.deleteMany({}), Task.deleteMany({}), TaskExecution.deleteMany({})]);
  await disconnectMongo();
});

describe("startExecution", () => {
  test("creates the run + one task per node; only roots are dispatched", async () => {
    const execution = await engine.startExecution({ workflow: diamond(), input: { invoice: 42 } });

    expect(execution).toMatchObject({ status: E.RUNNING, taskCount: 4, pendingTasks: 4, workflowVersion: 1 });
    const tasks = await Task.find({ executionId: execution._id }).sort({ key: 1 });
    expect(tasks.map((t) => [t.key, t.status, t.remainingDeps, t.dependents])).toEqual([
      ["A", T.QUEUED, 0, ["B", "C"]],
      ["B", T.PENDING, 1, ["D"]],
      ["C", T.PENDING, 1, ["D"]],
      ["D", T.PENDING, 2, []],
    ]);
    expect(enqueued).toEqual(["A"]);
  });

  test("ATOMIC: if creating tasks fails, the execution is rolled back too (no zombie run)", async () => {
    const broken = workflowOf(def("A"), { ...def("B", "A"), type: undefined }); // Task.type is required
    await expect(engine.startExecution({ workflow: broken })).rejects.toThrow();
    expect(await WorkflowExecution.countDocuments({})).toBe(0);
    expect(await Task.countDocuments({})).toBe(0);
    expect(enqueued).toEqual([]);
  });

  test("refuses to start an invalid graph (e.g. stored before Phase 4)", async () => {
    const cyclic = workflowOf(def("A", "B"), def("B", "A"));
    await expect(engine.startExecution({ workflow: cyclic })).rejects.toMatchObject({ code: "INVALID_WORKFLOW_GRAPH" });
    expect(await WorkflowExecution.countDocuments({})).toBe(0);
  });
});

describe("dependency resolution", () => {
  test("completing A releases B and C (parallel wave)", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    await startAndComplete(_id, "A");
    expect(enqueued.sort()).toEqual(["A", "B", "C"]);
    expect((await taskByKey(_id, "D")).remainingDeps).toBe(2);
  });

  test("D waits for BOTH parents, then the execution completes", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    await startAndComplete(_id, "A");
    await startAndComplete(_id, "B");
    expect((await taskByKey(_id, "D")).status).toBe(T.PENDING); // C not done yet
    await startAndComplete(_id, "C");
    expect((await taskByKey(_id, "D")).status).toBe(T.QUEUED);
    await startAndComplete(_id, "D");

    const execution = await WorkflowExecution.findById(_id);
    expect(execution).toMatchObject({ status: E.COMPLETED, pendingTasks: 0 });
    expect(execution.completedAt).toBeInstanceOf(Date);
  });

  test("RACE: B and C complete at the same moment -> D promoted and dispatched exactly once", async () => {
    for (let round = 0; round < 5; round++) {
      enqueued = [];
      const { _id } = await engine.startExecution({ workflow: diamond() });
      await startAndComplete(_id, "A");
      const [b, c] = await Promise.all([start(_id, "B"), start(_id, "C")]);

      await Promise.all([
        engine.completeTask({ taskId: b._id, leaseToken: b.leaseToken }),
        engine.completeTask({ taskId: c._id, leaseToken: c.leaseToken }),
      ]);

      const d = await taskByKey(_id, "D");
      expect(d.remainingDeps).toBe(0); // decremented exactly twice
      expect(d.status).toBe(T.QUEUED);
      expect(enqueued.filter((k) => k === "D")).toHaveLength(1);
    }
  });

  test("RACE (write skew): two LAST tasks finish at once -> execution still completes", async () => {
    for (let round = 0; round < 5; round++) {
      const { _id } = await engine.startExecution({ workflow: workflowOf(def("A"), def("X", "A"), def("Y", "A")) });
      await startAndComplete(_id, "A");
      const [x, y] = await Promise.all([start(_id, "X"), start(_id, "Y")]);

      await Promise.all([
        engine.completeTask({ taskId: x._id, leaseToken: x.leaseToken }),
        engine.completeTask({ taskId: y._id, leaseToken: y.leaseToken }),
      ]);

      expect(await executionState(_id)).toEqual({ status: E.COMPLETED, pendingTasks: 0 });
    }
  });
});

describe("idempotency and fencing", () => {
  test("a DUPLICATE completion report is a no-op (no double decrement)", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    await startAndComplete(_id, "A");
    const b = await start(_id, "B");

    const first = await engine.completeTask({ taskId: b._id, leaseToken: b.leaseToken });
    const second = await engine.completeTask({ taskId: b._id, leaseToken: b.leaseToken });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const d = await taskByKey(_id, "D");
    expect(d.remainingDeps).toBe(1); // NOT 0 — C hasn't finished
    expect(d.status).toBe(T.PENDING);
    expect((await WorkflowExecution.findById(_id)).pendingTasks).toBe(2);
  });

  test("a STALE lease token cannot complete the task", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const a = await start(_id, "A");
    const result = await engine.completeTask({ taskId: a._id, leaseToken: a.leaseToken - 1 });
    expect(result.applied).toBe(false);
    expect((await taskByKey(_id, "A")).status).toBe(T.RUNNING);
  });

  test("each claim records one TaskExecution attempt, closed on completion", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    await startAndComplete(_id, "A");
    const attempts = await TaskExecution.find({});
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, status: "SUCCEEDED", workerId: "test-worker" });
    expect(attempts[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test("handlers receive their parents' outputs and the run input", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond(), input: { invoice: 42 } });
    await startAndComplete(_id, "A", { a: 1 });
    await startAndComplete(_id, "B", { b: 2 });
    await startAndComplete(_id, "C", { c: 3 });
    const d = await taskByKey(_id, "D");
    const claimed = await engine.startTask(d._id, "w");
    expect(claimed.parents).toEqual({ B: { b: 2 }, C: { c: 3 } });
    expect(claimed.input).toEqual({ invoice: 42 });
  });
});

describe("failure (fail-fast)", () => {
  test("C fails while B runs: D cancelled, execution FAILED, B still allowed to finish", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    await startAndComplete(_id, "A");
    const [b, c] = await Promise.all([start(_id, "B"), start(_id, "C")]);

    await engine.failTask({ taskId: c._id, leaseToken: c.leaseToken, error: new Error("boom") });

    let execution = await WorkflowExecution.findById(_id);
    expect(execution.status).toBe(E.FAILED);
    expect(execution.error).toBe('Task "C" failed: boom');
    expect((await taskByKey(_id, "C")).status).toBe(T.FAILED);
    expect((await taskByKey(_id, "D")).status).toBe(T.CANCELLED);
    expect((await taskByKey(_id, "B")).status).toBe(T.RUNNING);
    expect(execution.pendingTasks).toBe(1); // only B left

    enqueued = [];
    await engine.completeTask({ taskId: b._id, leaseToken: b.leaseToken });
    execution = await WorkflowExecution.findById(_id);
    expect((await taskByKey(_id, "B")).status).toBe(T.COMPLETED);
    expect((await taskByKey(_id, "D")).status).toBe(T.CANCELLED); // not resurrected
    expect(execution).toMatchObject({ status: E.FAILED, pendingTasks: 0 }); // stays FAILED
    expect(enqueued).toEqual([]);
  });

  test("timeout errors are recorded as TIMED_OUT attempts", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const a = await start(_id, "A");
    const err = Object.assign(new Error("too slow"), { name: "TimeoutError" });
    await engine.failTask({ taskId: a._id, leaseToken: a.leaseToken, error: err });
    expect((await TaskExecution.findOne({ taskId: a._id })).status).toBe("TIMED_OUT");
  });
});

describe("recovery", () => {
  test("reconciler dispatches READY tasks that were never dispatched (crash after commit)", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    // Simulate: "A completed, B became READY, then the process died before dispatch".
    await Task.updateOne({ executionId: _id, key: "B" }, { $set: { status: T.READY, readyAt: new Date(Date.now() - 60_000) } });
    await Task.updateOne({ executionId: _id, key: "C" }, { $set: { status: T.READY, readyAt: new Date() } }); // fresh
    enqueued = [];

    const dispatched = await engine.reconcileStuckReady({ staleMs: 10_000 });

    expect(dispatched).toBe(1);
    expect(enqueued).toEqual(["B"]); // the fresh one is left alone
    expect((await taskByKey(_id, "B")).status).toBe(T.QUEUED);
  });

  test("reconciler and normal dispatch racing -> still dispatched once", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    await Task.updateOne({ executionId: _id, key: "B" }, { $set: { status: T.READY, readyAt: new Date(0) } });
    enqueued = [];
    await Promise.all([engine.reconcileStuckReady({ staleMs: 1 }), engine.dispatchReady(_id)]);
    expect(enqueued.filter((k) => k === "B")).toHaveLength(1);
  });

  test("after a restart, QUEUED/RUNNING orphans are dispatched again with a new fencing token", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A"), def("B")) });
    const a = await start(_id, "A"); // A RUNNING, B QUEUED — then "the process dies"
    enqueued = [];

    const recovered = await engine.recoverInProcessOrphans();

    expect(recovered).toBe(2);
    expect(enqueued.sort()).toEqual(["A", "B"]);
    const late = await engine.completeTask({ taskId: a._id, leaseToken: a.leaseToken });
    expect(late.applied).toBe(false); // the dead attempt's report is fenced off
  });
});
