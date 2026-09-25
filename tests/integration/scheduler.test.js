// Cron scheduler: leader election + per-slot idempotency.  Requires: npm run infra:up
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { createRedisClient } from "../../src/config/redis.js";
import { createEngine } from "../../src/workflow/engine.js";
import { createScheduler } from "../../src/scheduler/scheduler.js";
import { createLock } from "../../src/queues/lock.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { assertValidCron, nextRunAfter } from "../../src/scheduler/cron.js";
import { MONGO_URI, REDIS_URL, logger, createTestApp, createUser, as } from "../helpers/testApp.js";
import { User } from "../../src/models/user.model.js";

const engine = createEngine({ models: { WorkflowExecution, Task, TaskExecution }, enqueue: () => {}, logger });
let redis;
let lockName;
let clock;

function makeScheduler() {
  return createScheduler({
    Workflow,
    engine,
    lock: createLock(redis, lockName, { ttlMs: 10_000 }),
    logger,
    now: () => clock,
  });
}

async function scheduledWorkflow({ cron = "0 * * * *", nextRunAt, tasks } = {}) {
  return Workflow.create({
    ownerId: new mongoose.Types.ObjectId(),
    name: "nightly",
    tasks: tasks ?? [{ key: "A", type: "noop" }],
    schedule: { cron, timezone: "UTC", enabled: true, input: { source: "cron" }, nextRunAt },
  });
}

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await WorkflowExecution.init();
  redis = createRedisClient(REDIS_URL, logger, { name: "test-scheduler" });
  await redis.connect();
});
beforeEach(async () => {
  lockName = `test-scheduler-${randomUUID()}`;
  clock = new Date("2026-09-25T10:00:30Z");
  await Promise.all([Workflow, WorkflowExecution, Task, TaskExecution, User].map((m) => m.deleteMany({})));
});
afterEach(async () => {
  await redis.del(`wf:lock:${lockName}`, `wf:lock:${lockName}:fence`);
});
afterAll(async () => {
  await Promise.all([Workflow, WorkflowExecution, Task, TaskExecution, User].map((m) => m.deleteMany({})));
  await redis.quit();
  await disconnectMongo();
});

describe("cron helpers", () => {
  test("next slot, respecting the timezone", () => {
    const after = new Date("2026-09-25T10:00:00Z");
    expect(nextRunAfter("0 2 * * *", after, "UTC").toISOString()).toBe("2026-09-26T02:00:00.000Z");
    expect(nextRunAfter("0 2 * * *", after, "Asia/Kolkata").toISOString()).toBe("2026-09-25T20:30:00.000Z"); // 2am IST
  });

  test("rejects invalid, per-second (6-field) and bad-timezone expressions", () => {
    expect(() => assertValidCron("bad cron here x y")).toThrow(/Invalid cron/);
    expect(() => assertValidCron("*/5 * * * * *")).toThrow(/exactly 5 fields/);
    expect(() => assertValidCron("0 2 * * *", "Mars/Olympus")).toThrow(/Invalid cron/);
    expect(() => assertValidCron("0 2 * * *", "Asia/Kolkata")).not.toThrow();
  });
});

describe("scheduler", () => {
  test("a due schedule starts ONE run (trigger=schedule, schedule input, owner) and advances nextRunAt", async () => {
    const wf = await scheduledWorkflow({ nextRunAt: new Date("2026-09-25T10:00:00Z") });
    const scheduler = makeScheduler();

    expect(await scheduler.tick()).toBe(1);
    const runs = await WorkflowExecution.find({ workflowId: wf._id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "schedule", input: { source: "cron" }, idempotencyKey: `schedule:${wf._id}:2026-09-25T10:00:00.000Z` });
    expect(String(runs[0].triggeredBy)).toBe(String(wf.ownerId));

    const after = await Workflow.findById(wf._id);
    expect(after.schedule.nextRunAt.toISOString()).toBe("2026-09-25T11:00:00.000Z");

    expect(await scheduler.tick()).toBe(0); // same clock: nothing due
    await scheduler.stop();
  });

  test("not yet due -> nothing happens", async () => {
    await scheduledWorkflow({ nextRunAt: new Date("2026-09-25T11:00:00Z") });
    const scheduler = makeScheduler();
    expect(await scheduler.tick()).toBe(0);
    expect(await WorkflowExecution.countDocuments({})).toBe(0);
    await scheduler.stop();
  });

  test("NO BACKFILL: after a 5-hour outage an hourly job runs once, then resumes from now", async () => {
    const wf = await scheduledWorkflow({ nextRunAt: new Date("2026-09-25T05:00:00Z") });
    const scheduler = makeScheduler();
    await scheduler.tick();
    await scheduler.tick();
    expect(await WorkflowExecution.countDocuments({ workflowId: wf._id })).toBe(1);
    expect((await Workflow.findById(wf._id)).schedule.nextRunAt.toISOString()).toBe("2026-09-25T11:00:00.000Z");
    await scheduler.stop();
  });

  test("CRASH between 'start run' and 'advance nextRunAt' -> the retried slot is deduplicated", async () => {
    const slot = new Date("2026-09-25T10:00:00Z");
    const wf = await scheduledWorkflow({ nextRunAt: slot });
    // The previous leader started the run... and died before advancing nextRunAt.
    await engine.startExecution({
      workflow: wf,
      triggeredBy: wf.ownerId,
      trigger: "schedule",
      idempotencyKey: `schedule:${wf._id}:${slot.toISOString()}`,
    });

    const scheduler = makeScheduler();
    await scheduler.tick();
    expect(await WorkflowExecution.countDocuments({ workflowId: wf._id })).toBe(1); // not 2
    expect((await Workflow.findById(wf._id)).schedule.nextRunAt.toISOString()).toBe("2026-09-25T11:00:00.000Z");
    await scheduler.stop();
  });

  test("TWO schedulers ticking at once -> one leader, one run", async () => {
    const wf = await scheduledWorkflow({ nextRunAt: new Date("2026-09-25T10:00:00Z") });
    const [s1, s2] = [makeScheduler(), makeScheduler()];
    const started = await Promise.all([s1.tick(), s2.tick()]);
    expect(started.sort()).toEqual([0, 1]);
    expect(await WorkflowExecution.countDocuments({ workflowId: wf._id })).toBe(1);
    await Promise.all([s1.stop(), s2.stop()]);
  });

  test("EVEN WITHOUT the lock (two 'leaders'), the idempotency key keeps it to one run", async () => {
    const wf = await scheduledWorkflow({ nextRunAt: new Date("2026-09-25T10:00:00Z") });
    const noLock = () => createScheduler({
      Workflow,
      engine,
      lock: { acquire: async () => ({ token: "x", fence: 1 }), extend: async () => true, release: async () => true },
      logger,
      now: () => clock,
    });
    await Promise.all([noLock().tick(), noLock().tick(), noLock().tick()]);
    expect(await WorkflowExecution.countDocuments({ workflowId: wf._id })).toBe(1);
  });

  test("a workflow whose graph is invalid doesn't block the schedule: error recorded, next slot set", async () => {
    const wf = await scheduledWorkflow({
      nextRunAt: new Date("2026-09-25T10:00:00Z"),
      tasks: [{ key: "A", type: "noop", dependsOn: ["B"] }, { key: "B", type: "noop", dependsOn: ["A"] }],
    });
    const scheduler = makeScheduler();
    expect(await scheduler.tick()).toBe(0);
    const after = await Workflow.findById(wf._id);
    expect(after.schedule.lastError).toMatch(/invalid/i);
    expect(after.schedule.nextRunAt.toISOString()).toBe("2026-09-25T11:00:00.000Z");
    await scheduler.stop();
  });

  test("disabled schedules never run", async () => {
    const wf = await scheduledWorkflow({ nextRunAt: new Date("2026-09-25T09:00:00Z") });
    await Workflow.updateOne({ _id: wf._id }, { $set: { "schedule.enabled": false } });
    const scheduler = makeScheduler();
    expect(await scheduler.tick()).toBe(0);
    await scheduler.stop();
  });
});

describe("schedule API", () => {
  const app = createTestApp();
  let alice;
  let bob;
  let viewer;
  let wf;

  beforeEach(async () => {
    [alice, bob, viewer] = await Promise.all([
      createUser(`alice-${randomUUID()}@s.test`, "operator"),
      createUser(`bob-${randomUUID()}@s.test`, "operator"),
      createUser(`v-${randomUUID()}@s.test`, "viewer"),
    ]);
    wf = (await as(app, alice.token).post("/workflows").send({ name: "w", tasks: [{ key: "A", type: "noop" }] })).body.workflow;
  });

  test("PUT sets a schedule with the next slot; DELETE removes it", async () => {
    const res = await as(app, alice.token)
      .put(`/workflows/${wf.id}/schedule`)
      .send({ cron: "30 3 * * *", timezone: "Asia/Kolkata", input: { report: "daily" } });
    expect(res.status).toBe(200);
    expect(res.body.workflow.schedule).toMatchObject({ cron: "30 3 * * *", timezone: "Asia/Kolkata", enabled: true, input: { report: "daily" } });
    expect(new Date(res.body.workflow.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const del = await as(app, alice.token).delete(`/workflows/${wf.id}/schedule`);
    expect(del.status).toBe(200);
    expect(del.body.workflow.schedule).toBeUndefined();
  });

  test("invalid cron -> 400 INVALID_CRON; other owner -> 404; viewer -> 403", async () => {
    const bad = await as(app, alice.token).put(`/workflows/${wf.id}/schedule`).send({ cron: "* * * * * *" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_CRON");
    expect((await as(app, bob.token).put(`/workflows/${wf.id}/schedule`).send({ cron: "0 2 * * *" })).status).toBe(404);
    expect((await as(app, viewer.token).put(`/workflows/${wf.id}/schedule`).send({ cron: "0 2 * * *" })).status).toBe(403);
  });
});
