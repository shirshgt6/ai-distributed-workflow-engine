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
import { sleep } from "../../src/handlers/index.js";
import { NonRetryableError } from "../../src/workers/retry.js";

let enqueued = [];
let delayed = []; // [key, delayMs] scheduled retries
let redisDown = false; // flip to simulate the queue being unreachable
const engine = createEngine({
  models: { WorkflowExecution, Task, TaskExecution },
  enqueue: (item) => {
    if (redisDown) throw new Error("connect ECONNREFUSED (simulated)");
    enqueued.push(item.key);
  },
  enqueueDelayed: async (item, delayMs) => {
    if (redisDown) throw new Error("connect ECONNREFUSED (simulated)");
    const t = await Task.findById(item.taskId).select("key");
    delayed.push([t.key, delayMs]);
  },
  logger,
  leaseMs: 150, // short running lease, for takeover tests
  backoff: (attempt, baseDelayMs) => baseDelayMs * 2 ** (attempt - 1), // no jitter: deterministic
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
  delayed = [];
  redisDown = false;
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

    await engine.failTask({ taskId: c._id, leaseToken: c.leaseToken, error: new NonRetryableError("boom") });

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

describe("reconciler (MongoDB is the truth, Redis is made to agree)", () => {
  const old = () => new Date(Date.now() - 60_000);

  test("dispatches READY tasks that were never dispatched (crash after commit)", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    // Simulate: "A completed, B became READY, then the process died before dispatch".
    await Task.updateOne({ executionId: _id, key: "B" }, { $set: { status: T.READY, readyAt: old() } });
    await Task.updateOne({ executionId: _id, key: "C" }, { $set: { status: T.READY, readyAt: new Date() } }); // fresh
    enqueued = [];

    const counts = await engine.reconcile({ staleMs: 10_000 });

    expect(counts.ready).toBe(1);
    expect(enqueued).toEqual(["B"]); // the fresh one is left alone
    expect((await taskByKey(_id, "B")).status).toBe(T.QUEUED);
  });

  test("reconciler and normal dispatch racing -> still dispatched once", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    await Task.updateOne({ executionId: _id, key: "B" }, { $set: { status: T.READY, readyAt: new Date(0) } });
    enqueued = [];
    await Promise.all([engine.reconcile({ staleMs: 1 }), engine.dispatchReady(_id)]);
    expect(enqueued.filter((k) => k === "B")).toHaveLength(1);
  });

  test("Redis down during dispatch: the run still starts, and the reconciler enqueues later", async () => {
    redisDown = true;
    const execution = await engine.startExecution({ workflow: workflowOf(def("A")) }); // must NOT throw
    expect((await taskByKey(execution._id, "A")).status).toBe(T.QUEUED); // Mongo committed
    expect(enqueued).toEqual([]); // ...but nothing reached the queue

    redisDown = false;
    await Task.updateOne({ executionId: execution._id, key: "A" }, { $set: { queuedAt: old() } });
    const counts = await engine.reconcile({ staleMs: 10_000 });
    expect(counts.queued).toBe(1);
    expect(enqueued).toEqual(["A"]);
  });

  test("RUNNING tasks with an expired lease are re-enqueued for takeover", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    await start(_id, "A"); // lease = 150 ms ... and the worker "dies"
    enqueued = [];
    expect((await engine.reconcile({ staleMs: 10_000 })).running).toBe(0); // lease still live
    await sleep(200);
    expect((await engine.reconcile({ staleMs: 10_000 })).running).toBe(1);
    expect(enqueued).toEqual(["A"]);
  });
});

describe("leases and takeover", () => {
  test("a RUNNING task with a LIVE lease can't be claimed by another worker", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) }); // 30s timeout
    const a = await start(_id, "A");
    expect(await engine.startTask(a._id, "other-worker")).toBeNull();
  });

  test("after the lease expires, another worker TAKES OVER: attempt 2, new token, old attempt ABANDONED", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf({ ...def("A"), timeoutMs: 100 }) });
    const first = await start(_id, "A"); // worker 1 ... dies
    expect(first).toMatchObject({ attempt: 1, leaseOwner: "test-worker" });
    await sleep(200);

    const taken = await engine.startTask(first._id, "worker-2");
    expect(taken.task).toMatchObject({ attempt: 2, leaseOwner: "worker-2", leaseToken: first.leaseToken + 1 });

    const attempts = await TaskExecution.find({ taskId: first._id }).sort({ attempt: 1 });
    expect(attempts.map((a) => [a.attempt, a.workerId, a.status])).toEqual([
      [1, "test-worker", "ABANDONED"],
      [2, "worker-2", "RUNNING"],
    ]);

    // Worker 1 wakes up and reports: fenced off by the token.
    expect((await engine.completeTask({ taskId: first._id, leaseToken: first.leaseToken })).applied).toBe(false);
    // Worker 2's report is the one that counts.
    expect((await engine.completeTask({ taskId: first._id, leaseToken: taken.task.leaseToken })).applied).toBe(true);
  });

  test("the lease deadline is now + leaseMs, computed by MongoDB's clock", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const a = await start(_id, "A");
    expect(a.leaseExpiresAt - a.startedAt).toBe(150);
  });

  test("HEARTBEAT: renewing the lease keeps a slow task from being taken over", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const a = await start(_id, "A");
    for (let i = 0; i < 4; i++) {
      await sleep(80); // total 320ms > 150ms lease, but renewed every 80ms
      expect(await engine.renewLease(a._id, a.leaseToken)).toBe(true);
    }
    expect(await engine.startTask(a._id, "thief")).toBeNull();
  });

  test("renewal fails once the task was taken over (so the old worker aborts)", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const a = await start(_id, "A");
    await sleep(200);
    await engine.startTask(a._id, "w2"); // takeover
    expect(await engine.renewLease(a._id, a.leaseToken)).toBe(false);
  });
});

describe("retries, backoff and dead-lettering (Phase 8)", () => {
  // maxAttempts 3, baseDelayMs 1000 (from def()).
  async function failAttempt(executionId, key, error) {
    const task = await start(executionId, key);
    return engine.failTask({ taskId: task._id, leaseToken: task.leaseToken, error });
  }

  test("a transient error is RETRIED with exponential backoff (1s, 2s), not failed", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });

    const r1 = await failAttempt(_id, "A", new Error("ECONNRESET"));
    expect(r1).toMatchObject({ applied: true, outcome: T.RETRYING, delayMs: 1000 });
    let a = await taskByKey(_id, "A");
    expect(a).toMatchObject({ status: T.RETRYING, attempt: 1, error: "ECONNRESET", leaseOwner: null });
    expect(a.retryAt).toBeInstanceOf(Date);
    expect(delayed).toEqual([["A", 1000]]);

    const r2 = await failAttempt(_id, "A", new Error("ECONNRESET")); // RETRYING is claimable
    expect(r2).toMatchObject({ outcome: T.RETRYING, delayMs: 2000 });
    a = await taskByKey(_id, "A");
    expect(a.attempt).toBe(2);
    expect(await executionState(_id)).toEqual({ status: E.RUNNING, pendingTasks: 1 }); // not finished yet
  });

  test("retry then success: the execution completes and history shows every attempt", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    await failAttempt(_id, "A", new Error("blip"));
    await startAndComplete(_id, "A");
    expect(await executionState(_id)).toEqual({ status: E.COMPLETED, pendingTasks: 0 });
    const attempts = await TaskExecution.find({}).sort({ attempt: 1 });
    expect(attempts.map((x) => [x.attempt, x.status, x.error?.retryable ?? null])).toEqual([
      [1, "FAILED", true],
      [2, "SUCCEEDED", null],
    ]);
  });

  test("attempts exhausted -> DEAD_LETTER, and the run fails (fail-fast)", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A"), def("B", "A")) });
    await failAttempt(_id, "A", new Error("still down"));
    await failAttempt(_id, "A", new Error("still down"));
    const last = await failAttempt(_id, "A", new Error("still down")); // attempt 3 of 3

    expect(last.outcome).toBe(T.DEAD_LETTER);
    expect((await taskByKey(_id, "A")).status).toBe(T.DEAD_LETTER);
    expect((await taskByKey(_id, "B")).status).toBe(T.CANCELLED);
    const execution = await WorkflowExecution.findById(_id);
    expect(execution.status).toBe(E.FAILED);
    expect(execution.error).toBe('Task "A" failed after 3 attempt(s) and was dead-lettered: still down');
    expect(delayed).toHaveLength(2); // only the first two failures scheduled a retry
  });

  test("a NON-retryable error fails immediately, no retry", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const r = await failAttempt(_id, "A", new NonRetryableError("card declined"));
    expect(r.outcome).toBe(T.FAILED);
    expect(delayed).toEqual([]);
    expect(await executionState(_id)).toEqual({ status: E.FAILED, pendingTasks: 0 });
  });

  test("no retries once the run has already failed (a sibling failed)", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A"), def("B")) });
    const [a, b] = await Promise.all([start(_id, "A"), start(_id, "B")]);
    await engine.failTask({ taskId: a._id, leaseToken: a.leaseToken, error: new NonRetryableError("fatal") });
    const r = await engine.failTask({ taskId: b._id, leaseToken: b.leaseToken, error: new Error("transient") });
    expect(r.outcome).toBe(T.FAILED);
    expect(delayed).toEqual([]);
  });

  test("a task waiting to RETRY is cancelled if the run fails meanwhile", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A"), def("B")) });
    await failAttempt(_id, "A", new Error("blip")); // A -> RETRYING
    await failAttempt(_id, "B", new NonRetryableError("fatal")); // run fails
    expect((await taskByKey(_id, "A")).status).toBe(T.CANCELLED);
    expect(await executionState(_id)).toEqual({ status: E.FAILED, pendingTasks: 0 });
  });

  test("POISON PILL: takeovers count as attempts; past maxAttempts the task is dead-lettered, not run", async () => {
    const { _id } = await engine.startExecution({
      workflow: workflowOf({ ...def("A"), timeoutMs: 100, retryPolicy: { maxAttempts: 2, baseDelayMs: 10 } }),
    });
    await start(_id, "A"); // attempt 1: worker dies
    await sleep(200);
    const a = await taskByKey(_id, "A");
    expect((await engine.startTask(a._id, "w2")).task.attempt).toBe(2); // takeover, worker dies again
    await sleep(200);
    expect(await engine.startTask(a._id, "w3")).toBeNull(); // attempt 3 > 2: refused
    expect((await taskByKey(_id, "A")).status).toBe(T.DEAD_LETTER);
    expect((await WorkflowExecution.findById(_id)).error).toMatch(/Exceeded 2 attempts/);
  });

  test("reconciler re-enqueues a retry whose delayed wake-up was lost", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    redisDown = true;
    await failAttempt(_id, "A", new Error("blip")); // RETRYING committed, scheduling failed
    redisDown = false;
    expect(delayed).toEqual([]);
    await Task.updateOne({ executionId: _id, key: "A" }, { $set: { retryAt: new Date(Date.now() - 60_000) } });
    enqueued = [];
    const counts = await engine.reconcile({ staleMs: 10_000 });
    expect(counts.retrying).toBe(1);
    expect(enqueued).toEqual(["A"]);
  });
});

describe("pause / resume / cancel", () => {
  test("PAUSE stops new dispatch; children stay PENDING; RESUME promotes and dispatches them", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    const a = await start(_id, "A");
    expect(await engine.pauseExecution(_id)).toBe(true);
    enqueued = [];
    await engine.completeTask({ taskId: a._id, leaseToken: a.leaseToken }); // A finishes while paused
    expect(enqueued).toEqual([]); // nothing new started
    expect((await taskByKey(_id, "B")).toObject()).toMatchObject({ status: T.PENDING, remainingDeps: 0 });

    expect(await engine.resumeExecution(_id)).toBe(true);
    expect(enqueued.sort()).toEqual(["B", "C"]);
    expect((await WorkflowExecution.findById(_id)).status).toBe(E.RUNNING);
  });

  test("resume of a run whose tasks all finished while paused completes it", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const a = await start(_id, "A");
    await engine.pauseExecution(_id);
    await engine.completeTask({ taskId: a._id, leaseToken: a.leaseToken });
    expect(await executionState(_id)).toEqual({ status: E.PAUSED, pendingTasks: 0 });
    await engine.resumeExecution(_id);
    expect(await executionState(_id)).toEqual({ status: E.COMPLETED, pendingTasks: 0 });
  });

  test("pause/resume only from the right state", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    expect(await engine.resumeExecution(_id)).toBe(false); // not paused
    expect(await engine.pauseExecution(_id)).toBe(true);
    expect(await engine.pauseExecution(_id)).toBe(false); // already paused
  });

  test("CANCEL: every unfinished task (even RUNNING) is cancelled; the worker's lease renewal and report are rejected", async () => {
    const { _id } = await engine.startExecution({ workflow: diamond() });
    const a = await start(_id, "A");
    expect(await engine.cancelExecution(_id)).toBe(true);

    const tasks = await Task.find({ executionId: _id });
    expect(tasks.every((t) => t.status === T.CANCELLED)).toBe(true);
    expect(await executionState(_id)).toEqual({ status: E.CANCELLED, pendingTasks: 0 });
    expect(await engine.renewLease(a._id, a.leaseToken)).toBe(false); // worker will abort
    expect((await engine.completeTask({ taskId: a._id, leaseToken: a.leaseToken })).applied).toBe(false);
    expect(await engine.cancelExecution(_id)).toBe(false); // already finished
  });

  test("RACE: cancel vs the last task completing -> exactly one outcome, consistent counters", async () => {
    for (let round = 0; round < 5; round++) {
      const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
      const a = await start(_id, "A");
      const [, cancelled] = await Promise.all([
        engine.completeTask({ taskId: a._id, leaseToken: a.leaseToken }),
        engine.cancelExecution(_id),
      ]);
      const state = await executionState(_id);
      expect(state.pendingTasks).toBe(0);
      expect(state.status).toBe(cancelled ? E.CANCELLED : E.COMPLETED);
    }
  });
});
