import os from "node:os";
import dotenv from "dotenv";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { connectMongo, disconnectMongo } from "./config/mongo.js";
import { createRedisClient } from "./config/redis.js";
import { WorkflowExecution } from "./models/workflowExecution.model.js";
import { Task } from "./models/task.model.js";
import { TaskExecution } from "./models/taskExecution.model.js";
import { createEngine } from "./workflow/engine.js";
import { createTaskQueue } from "./queues/taskQueue.js";
import { createQueueWorker } from "./workers/queueWorker.js";
import { handlers as builtinHandlers } from "./handlers/index.js";
import { createAiHandlers } from "./handlers/ai.js";
import { createProviderFromConfig } from "./ai/providers/index.js";
import { createRagFromConfig } from "./ai/rag/index.js";
import { Worker } from "./models/worker.model.js";
import { createWorkerRegistry } from "./workers/registry.js";
import { OutboxEvent } from "./models/outboxEvent.model.js";
import { createLock } from "./queues/lock.js";
import { createOutboxRelay, createRelayRunner } from "./events/relay.js";
import { createKafkaPublisher } from "./events/kafka.js";
import { Workflow } from "./models/workflow.model.js";
import { createScheduler } from "./scheduler/scheduler.js";

// WORKER PROCESS ENTRYPOINT:  npm run worker
//
// Runs task handlers, separately from the API. Start as many as you like (on
// one machine or many): they coordinate only through Redis (who takes which
// task) and MongoDB (task state). There is no leader. Each worker registers
// in a registry and heartbeats, but only for visibility (GET /workers):
// correctness comes from task leases. More load -> more worker processes,
// no code change: that is "horizontal scaling" here.
//
// Why a separate process: a CPU-heavy or memory-hungry task can no longer
// slow down or crash the API, and API and workers scale independently.
async function main() {
  dotenv.config({ quiet: true });
  const config = loadConfig();
  const workerId = `${os.hostname()}-${process.pid}`;
  const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction }).child({ role: "worker" });

  await connectMongo(config.mongo.uri, logger);
  const redis = createRedisClient(config.redis.url, logger, { name: "worker" });
  await redis.connect();

  const queue = createTaskQueue(redis);
  // Built-in handlers + AI handlers (which receive the LLM provider).
  const llm = createProviderFromConfig(config.llm);
  const { rag } = createRagFromConfig({ config, provider: llm, logger });
  const handlers = { ...builtinHandlers, ...createAiHandlers({ provider: llm, models: config.llm.models, logger, rag }) };
  const engine = createEngine({
    models: { WorkflowExecution, Task, TaskExecution, OutboxEvent },
    enqueue: (item) => queue.enqueue(item.taskId),
    enqueueDelayed: (item, delayMs) => queue.enqueueDelayed(item.taskId, delayMs),
    logger,
    leaseMs: config.worker.leaseMs,
  });
  const registry = createWorkerRegistry({
    Worker,
    redis,
    workerId,
    host: os.hostname(),
    pid: process.pid,
    concurrency: config.worker.concurrency,
    ttlMs: config.worker.leaseMs,
    logger,
  });
  const worker = createQueueWorker({
    queue,
    engine,
    handlers,
    logger,
    workerId,
    concurrency: config.worker.concurrency,
    pollIntervalMs: config.worker.pollIntervalMs,
    claimLeaseMs: config.worker.claimLeaseMs,
    leaseMs: config.worker.leaseMs,
    registry,
  });
  await worker.start();

  // CRON SCHEDULER: every worker runs one; only the "scheduler" lock holder
  // ticks. Duplicate starts are deduped by per-slot idempotency keys.
  const scheduler = createScheduler({
    Workflow,
    engine,
    lock: createLock(redis, "scheduler", { ttlMs: Math.max(10_000, config.scheduler.tickMs * 3) }),
    logger,
  });
  scheduler.start(config.scheduler.tickMs);

  // OUTBOX RELAY: every worker runs one, but only the holder of the
  // "outbox-relay" lock publishes (leader election). If Kafka is down, events
  // simply wait in MongoDB; task execution is unaffected.
  const publisher = createKafkaPublisher({
    brokers: config.kafka.brokers,
    topic: config.kafka.topic,
    clientId: `relay-${workerId}`,
    logger,
  });
  let relayRunner = null;
  try {
    await publisher.connect();
    relayRunner = createRelayRunner({
      relay: createOutboxRelay({ OutboxEvent, publish: publisher.publish, logger }),
      lock: createLock(redis, "outbox-relay", { ttlMs: Math.max(3000, config.kafka.relayIntervalMs * 6) }),
      intervalMs: config.kafka.relayIntervalMs,
      logger,
    });
    relayRunner.start();
  } catch (err) {
    logger.warn({ err: err.message }, "Kafka unavailable; outbox events will stay in MongoDB until a worker can relay them");
  }

  // Every worker also runs the reconciler. Its steps are CAS or idempotent
  // enqueues, so several workers reconciling at once is safe (just redundant).
  const reconcileTimer = setInterval(() => {
    engine
      .reconcile({ staleMs: config.reconciler.staleMs })
      .catch((err) => logger.error({ err: err.message }, "reconciler run failed"));
  }, config.reconciler.intervalMs);

  // GRACEFUL SHUTDOWN (SIGTERM from Docker/Kubernetes on deploy, or Ctrl+C):
  //   1. stop claiming new tasks
  //   2. let in-flight tasks finish and REPORT their result
  //   3. close connections, exit 0
  // If a task takes longer than SHUTDOWN_TIMEOUT_MS we force-exit. Nothing is
  // lost: the task's lease expires and another worker takes it over.
  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal, workerId }, "worker shutting down gracefully");
    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: config.shutdownTimeoutMs }, "graceful shutdown timed out; leases will expire and other workers take over");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    clearInterval(reconcileTimer);
    await worker.stop();
    await scheduler.stop();
    if (relayRunner) await relayRunner.stop();
    await publisher.disconnect().catch(() => {});
    await Promise.allSettled([disconnectMongo(), redis.quit()]);
    logger.info("worker stopped");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    shutdown("unhandledRejection");
  });
}

main().catch((err) => {
  process.stderr.write(`[fatal] worker failed to start: ${err.stack ?? err}\n`);
  process.exit(1);
});
