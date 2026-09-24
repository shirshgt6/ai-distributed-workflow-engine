// Requires real infrastructure:  npm run infra:up
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { transitionTask } from "../../src/repositories/task.repository.js";
import { TASK_STATUS as T, InvalidTransitionError } from "../../src/workflow/states.js";
import { MONGO_URI, logger } from "../helpers/testApp.js";

const executionId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();

async function makeTask(overrides = {}) {
  return Task.create({
    executionId,
    ownerId,
    key: `t-${new mongoose.Types.ObjectId()}`,
    type: "noop",
    remainingDeps: 0,
    ...overrides,
  });
}

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await Promise.all([Task.deleteMany({}), TaskExecution.deleteMany({})]);
  await Promise.all([Task.init(), TaskExecution.init()]);
});

afterAll(async () => {
  await Promise.all([Task.deleteMany({}), TaskExecution.deleteMany({})]);
  await disconnectMongo();
});

describe("transitionTask (compare-and-set on status)", () => {
  test("legal transition from the expected state succeeds", async () => {
    const task = await makeTask({ status: T.RUNNING });
    expect(await transitionTask(task._id, T.RUNNING, T.COMPLETED, { set: { output: { ok: 1 } } })).toBe(true);
    const stored = await Task.findById(task._id);
    expect(stored.status).toBe(T.COMPLETED);
    expect(stored.output).toEqual({ ok: 1 });
  });

  test("returns false (no write) when the task is no longer in the expected state", async () => {
    const task = await makeTask({ status: T.CANCELLED });
    expect(await transitionTask(task._id, T.RUNNING, T.COMPLETED)).toBe(false);
    expect((await Task.findById(task._id)).status).toBe(T.CANCELLED);
  });

  test("an illegal transition throws BEFORE touching the database", async () => {
    const task = await makeTask({ status: T.COMPLETED });
    await expect(transitionTask(task._id, T.COMPLETED, T.READY)).rejects.toThrow(InvalidTransitionError);
    expect((await Task.findById(task._id)).status).toBe(T.COMPLETED);
  });

  test("RACE: 10 workers try RUNNING -> COMPLETED at once -> exactly one wins", async () => {
    const task = await makeTask({ status: T.RUNNING });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        transitionTask(task._id, T.RUNNING, T.COMPLETED, { set: { output: { winner: i } } })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.indexOf(true);
    expect((await Task.findById(task._id)).output).toEqual({ winner });
  });

  test("RACE: complete vs cancel at the same moment -> exactly one outcome sticks", async () => {
    const task = await makeTask({ status: T.RUNNING });
    const [completed, cancelled] = await Promise.all([
      transitionTask(task._id, T.RUNNING, T.COMPLETED),
      transitionTask(task._id, T.RUNNING, T.CANCELLED),
    ]);
    expect(completed !== cancelled).toBe(true); // one true, one false
    expect((await Task.findById(task._id)).status).toBe(completed ? T.COMPLETED : T.CANCELLED);
  });

  test("fencing: a stale lease token cannot complete the task (ABA protection)", async () => {
    // Worker "w1" held the task with token 1, lost it, then got it back with token 2.
    const task = await makeTask({ status: T.RUNNING, leaseOwner: "w1", leaseToken: 2 });
    const stale = await transitionTask(task._id, T.RUNNING, T.COMPLETED, { where: { leaseOwner: "w1", leaseToken: 1 } });
    expect(stale).toBe(false); // same worker NAME, old token -> rejected
    const current = await transitionTask(task._id, T.RUNNING, T.COMPLETED, {
      where: { leaseOwner: "w1", leaseToken: 2 },
    });
    expect(current).toBe(true);
  });
});

describe("unique indexes", () => {
  test("one task per key per execution", async () => {
    await makeTask({ key: "dup-key" });
    await expect(makeTask({ key: "dup-key" })).rejects.toMatchObject({ code: 11000 });
  });

  test("one TaskExecution record per (task, attempt)", async () => {
    const task = await makeTask();
    const attempt = { taskId: task._id, executionId, attempt: 1, workerId: "w1", leaseToken: 1 };
    await TaskExecution.create(attempt);
    await expect(TaskExecution.create(attempt)).rejects.toMatchObject({ code: 11000 });
  });
});
