// Transactional outbox, relay, idempotent consumer, and a real Kafka round trip.
// Requires:  npm run infra:up  (Mongo, Redis, Kafka)
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { createRedisClient } from "../../src/config/redis.js";
import { createEngine } from "../../src/workflow/engine.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { OutboxEvent } from "../../src/models/outboxEvent.model.js";
import { ProcessedEvent, EventStat } from "../../src/models/analytics.model.js";
import { createOutboxRelay, createRelayRunner } from "../../src/events/relay.js";
import { createAnalyticsProcessor } from "../../src/events/analyticsProcessor.js";
import { createKafkaPublisher, createKafkaConsumer } from "../../src/events/kafka.js";
import { createLock } from "../../src/queues/lock.js";
import { NonRetryableError } from "../../src/workers/retry.js";
import { MONGO_URI, REDIS_URL, logger, waitFor } from "../helpers/testApp.js";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS_TEST ?? "localhost:9095").split(",");
const models = { WorkflowExecution, Task, TaskExecution, OutboxEvent };
const engine = createEngine({ models, enqueue: () => {}, enqueueDelayed: () => {}, logger, leaseMs: 5000 });

const ownerId = new mongoose.Types.ObjectId();
const def = (key, ...dependsOn) => ({ key, type: "noop", dependsOn, config: {}, retryPolicy: { maxAttempts: 1 }, timeoutMs: 1000 });
const workflowOf = (...tasks) => ({ _id: new mongoose.Types.ObjectId(), ownerId, version: 1, tasks });

async function runTask(executionId, key, { fail } = {}) {
  const task = await Task.findOne({ executionId, key });
  const { task: t } = await engine.startTask(task._id, "w1");
  if (fail) return engine.failTask({ taskId: t._id, leaseToken: t.leaseToken, error: new NonRetryableError(fail) });
  return engine.completeTask({ taskId: t._id, leaseToken: t.leaseToken });
}
const typesOf = async (executionId) =>
  (await OutboxEvent.find({ aggregateId: String(executionId) }).sort({ _id: 1 })).map((e) => e.type);

let redis;
beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await Promise.all([OutboxEvent.init(), ProcessedEvent.init(), EventStat.init(), Task.init()]);
  redis = createRedisClient(REDIS_URL, logger, { name: "test-outbox" });
  await redis.connect();
});
beforeEach(async () => {
  await Promise.all([WorkflowExecution, Task, TaskExecution, OutboxEvent, ProcessedEvent, EventStat].map((m) => m.deleteMany({})));
});
afterAll(async () => {
  await Promise.all([WorkflowExecution, Task, TaskExecution, OutboxEvent, ProcessedEvent, EventStat].map((m) => m.deleteMany({})));
  await redis.quit();
  await disconnectMongo();
});

describe("transactional outbox", () => {
  test("every state change of a run writes its event, in order", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A"), def("B", "A")) });
    await runTask(_id, "A");
    await runTask(_id, "B");
    expect(await typesOf(_id)).toEqual([
      "execution.started",
      "task.started",
      "task.completed",
      "task.started",
      "execution.completed",
      "task.completed",
    ]);
  });

  test("failure path events (task.failed + execution.failed)", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    await runTask(_id, "A", { fail: "boom" });
    expect(await typesOf(_id)).toEqual(["execution.started", "task.started", "execution.failed", "task.failed"]);
  });

  test("ROLLBACK: a failed transaction leaves NO event behind (no event for a change that didn't happen)", async () => {
    const broken = workflowOf(def("A"), { ...def("B", "A"), type: undefined }); // task insert fails
    await expect(engine.startExecution({ workflow: broken })).rejects.toThrow();
    expect(await OutboxEvent.countDocuments({})).toBe(0);
  });

  test("a DUPLICATE completion report emits no second event (CAS guards the emit too)", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const task = await Task.findOne({ executionId: _id });
    const { task: t } = await engine.startTask(task._id, "w1");
    await engine.completeTask({ taskId: t._id, leaseToken: t.leaseToken });
    await engine.completeTask({ taskId: t._id, leaseToken: t.leaseToken });
    expect((await typesOf(_id)).filter((x) => x === "task.completed")).toHaveLength(1);
  });

  test("pause / resume / cancel emit events", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    await engine.pauseExecution(_id);
    await engine.resumeExecution(_id);
    await engine.cancelExecution(_id);
    expect(await typesOf(_id)).toEqual(["execution.started", "execution.paused", "execution.resumed", "execution.cancelled"]);
  });
});

describe("relay", () => {
  test("publishes unpublished events (keyed by execution), marks them, and is then idle", async () => {
    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    const sent = [];
    const relay = createOutboxRelay({ OutboxEvent, publish: async (msgs) => sent.push(...msgs), logger });
    expect(await relay.relayOnce()).toBe(1);
    expect(sent[0].key).toBe(String(_id));
    expect(JSON.parse(sent[0].value)).toMatchObject({ type: "execution.started", aggregateId: String(_id) });
    expect(await relay.relayOnce()).toBe(0);
    expect(await OutboxEvent.countDocuments({ publishedAt: null })).toBe(0);
  });

  test("Kafka down: nothing is marked published, nothing is lost; it goes out on the next try", async () => {
    await engine.startExecution({ workflow: workflowOf(def("A")) });
    let kafkaUp = false;
    const sent = [];
    const relay = createOutboxRelay({
      OutboxEvent,
      publish: async (msgs) => {
        if (!kafkaUp) throw new Error("broker unavailable");
        sent.push(...msgs);
      },
      logger,
    });
    await expect(relay.relayOnce()).rejects.toThrow("broker unavailable");
    expect(await OutboxEvent.countDocuments({ publishedAt: null })).toBe(1);
    kafkaUp = true;
    expect(await relay.relayOnce()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test("LEADER ELECTION: two relay runners, one lock -> only one publishes", async () => {
    await engine.startExecution({ workflow: workflowOf(def("A"), def("B")) });
    const lockName = `test-relay-${randomUUID()}`;
    const published = { r1: 0, r2: 0 };
    const make = (name) =>
      createRelayRunner({
        relay: createOutboxRelay({ OutboxEvent, publish: async (m) => (published[name] += m.length), logger }),
        lock: createLock(redis, lockName, { ttlMs: 5000 }),
        intervalMs: 1_000_000,
        logger,
      });
    const [r1, r2] = [make("r1"), make("r2")];
    await Promise.all([r1.tick(), r2.tick()]);
    expect(published.r1 + published.r2).toBe(1); // 1 execution.started event, published once
    expect(Math.min(published.r1, published.r2)).toBe(0);
    await r1.stop();
    await r2.stop();
    await redis.del(`wf:lock:${lockName}`, `wf:lock:${lockName}:fence`);
  });
});

describe("idempotent consumer", () => {
  const processor = createAnalyticsProcessor({ ProcessedEvent, EventStat });
  const event = (type = "task.completed") => ({ eventId: randomUUID(), type, occurredAt: new Date().toISOString() });
  const count = async (type) => (await EventStat.findOne({ type }))?.count ?? 0;

  test("the same event delivered twice is counted once", async () => {
    const e = event();
    expect(await processor.process(e)).toBe("applied");
    expect(await processor.process(e)).toBe("duplicate");
    expect(await count("task.completed")).toBe(1);
  });

  test("RACE: 5 concurrent deliveries of one event -> applied exactly once", async () => {
    const e = event("execution.completed");
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => processor.process(e)));
    expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
    expect(await count("execution.completed")).toBe(1);
  });
});

describe("real Kafka round trip", () => {
  test("outbox -> relay -> Kafka -> consumer group -> dedup'd stats (with a forced duplicate publish)", async () => {
    const topic = `test-events-${randomUUID()}`;
    const publisher = createKafkaPublisher({ brokers: KAFKA_BROKERS, topic, clientId: "test-relay", partitions: 3, logger });
    await publisher.connect();

    const { _id } = await engine.startExecution({ workflow: workflowOf(def("A")) });
    await runTask(_id, "A"); // 4 events: started, task.started, execution.completed, task.completed
    const rows = await OutboxEvent.find({}).lean();

    const relay = createOutboxRelay({ OutboxEvent, publish: publisher.publish, logger });
    expect(await relay.relayOnce()).toBe(4);
    // Simulate "relay crashed after publishing, before marking": publish them all AGAIN.
    await OutboxEvent.updateMany({}, { $set: { publishedAt: null } });
    expect(await relay.relayOnce()).toBe(4); // 8 messages now in Kafka for 4 real events

    const processor = createAnalyticsProcessor({ ProcessedEvent, EventStat, consumer: `test-${topic}` });
    const outcomes = [];
    const consumer = createKafkaConsumer({ brokers: KAFKA_BROKERS, clientId: "test-consumer", groupId: `g-${topic}` });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({ eachMessage: async ({ message }) => outcomes.push(await processor.process(JSON.parse(message.value))) });

    await waitFor(() => outcomes.length === 8, { timeoutMs: 25_000 });
    await consumer.disconnect();
    await publisher.disconnect();

    expect(outcomes.filter((o) => o === "applied")).toHaveLength(4);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(4);
    const stats = Object.fromEntries((await EventStat.find({})).map((s) => [s.type, s.count]));
    expect(stats).toEqual({ "execution.started": 1, "task.started": 1, "execution.completed": 1, "task.completed": 1 });
    expect(rows).toHaveLength(4);
  }, 40_000);
});
