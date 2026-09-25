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
import { handlers } from "./handlers/index.js";

// WORKER PROCESS ENTRYPOINT:  npm run worker
//
// Runs task handlers, separately from the API. Start as many as you like (on
// one machine or many): they coordinate only through Redis (who takes which
// task) and MongoDB (task state). There is no leader and no registration
// step. That is what "horizontal scaling" means here: more load, more
// worker processes, no code change.
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
  const engine = createEngine({
    models: { WorkflowExecution, Task, TaskExecution },
    enqueue: (item) => queue.enqueue(item.taskId),
    enqueueDelayed: (item, delayMs) => queue.enqueueDelayed(item.taskId, delayMs),
    logger,
    leaseGraceMs: config.worker.leaseGraceMs,
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
    leaseGraceMs: config.worker.leaseGraceMs,
  });
  worker.start();

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
