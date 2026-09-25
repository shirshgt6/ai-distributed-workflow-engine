// CRASH RECOVERY, end to end: real MongoDB + real Redis + a real worker.
// Each test plays a worker that dies at a specific moment, then checks that
// a healthy worker finishes the run anyway.
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { MONGO_URI, logger, createTestStack, waitFor } from "../helpers/testApp.js";

const LEASE_MS = 300;
let stack;

const ownerId = new mongoose.Types.ObjectId();
const workflowOf = (...tasks) => ({
  _id: new mongoose.Types.ObjectId(),
  ownerId,
  version: 1,
  tasks: tasks.map((t) => ({ dependsOn: [], config: {}, retryPolicy: { maxAttempts: 3 }, timeoutMs: 30_000, ...t })),
});

async function finalState(executionId) {
  return waitFor(
    async () => {
      const e = await WorkflowExecution.findById(executionId).lean();
      return ["COMPLETED", "FAILED"].includes(e.status) ? e.status : null;
    },
    { timeoutMs: 8000 }
  );
}

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
});

beforeEach(async () => {
  await Promise.all([WorkflowExecution.deleteMany({}), Task.deleteMany({}), TaskExecution.deleteMany({})]);
  stack = createTestStack({ concurrency: 2, leaseMs: LEASE_MS, workerId: "healthy-worker" });
  await stack.start({ startWorker: false });
});

afterEach(async () => {
  await stack.stop();
});

afterAll(async () => {
  await Promise.all([WorkflowExecution.deleteMany({}), Task.deleteMany({}), TaskExecution.deleteMany({})]);
  await disconnectMongo();
});

test("worker pops a task from Redis and dies BEFORE recording it in MongoDB (Project 1's lost job)", async () => {
  const { engine, queue, worker } = stack;
  const execution = await engine.startExecution({ workflow: workflowOf({ key: "A", type: "noop" }) });

  // The doomed worker: atomic pop + 150ms lease ... then nothing.
  expect(await queue.claim(150)).toBe(String((await Task.findOne({ key: "A" }))._id));
  expect(await queue.stats()).toMatchObject({ ready: 0, leased: 1 }); // not lost: leased

  worker.start(); // a healthy worker comes along
  expect(await finalState(execution._id)).toBe("COMPLETED");
  const task = await Task.findOne({ executionId: execution._id });
  expect(task).toMatchObject({ status: "COMPLETED", attempt: 1 }); // MongoDB never saw the dead pop
});

test("worker dies in the MIDDLE of a task: the lease expires and another worker takes over", async () => {
  const { engine, queue, worker } = stack;
  const execution = await engine.startExecution({
    workflow: workflowOf({ key: "A", type: "noop" }, { key: "B", type: "echo", dependsOn: ["A"] }),
  });

  // The doomed worker does everything a real one does up to running the handler...
  const id = await queue.claim(30_000);
  const claimed = await engine.startTask(id, "doomed-worker");
  await queue.extendLease(id, LEASE_MS);
  // ...and then the process is killed. No report, no ack, NO MORE HEARTBEATS.

  worker.start();
  expect(await finalState(execution._id)).toBe("COMPLETED");

  const a = await Task.findOne({ executionId: execution._id, key: "A" });
  expect(a).toMatchObject({ status: "COMPLETED", attempt: 2, leaseOwner: null });
  const attempts = await TaskExecution.find({ taskId: a._id }).sort({ attempt: 1 });
  expect(attempts.map((x) => [x.workerId, x.status])).toEqual([
    ["doomed-worker", "ABANDONED"],
    ["healthy-worker", "SUCCEEDED"],
  ]);

  // The zombie wakes up and tries to report: rejected by the fencing token.
  expect((await engine.completeTask({ taskId: a._id, leaseToken: claimed.task.leaseToken })).applied).toBe(false);
});

test("Redis loses ALL its data mid-run: the reconciler rebuilds the queue from MongoDB", async () => {
  const { engine, queue, worker, redis } = stack;
  const execution = await engine.startExecution({
    workflow: workflowOf({ key: "A", type: "noop" }, { key: "B", type: "noop" }),
  });
  expect(await queue.stats()).toMatchObject({ ready: 2 });

  await redis.del(...Object.values(queue.keys)); // e.g. Redis restarted without persistence
  worker.start();
  await new Promise((r) => setTimeout(r, 100));
  expect((await WorkflowExecution.findById(execution._id)).status).toBe("RUNNING"); // stuck: nothing to pull

  // MongoDB still says QUEUED. The reconciler makes Redis agree again.
  const counts = await engine.reconcile({ staleMs: 0 });
  expect(counts.queued).toBe(2);
  expect(await finalState(execution._id)).toBe("COMPLETED");
});
