import { runTask } from "./runTask.js";
import { sleep } from "../handlers/index.js";

/**
 * QUEUE WORKER — pulls task ids from Redis and runs them.
 *
 * `concurrency` independent loops, each doing:
 *
 *   claim id from Redis (atomic pop + short lease)       ── nothing? sleep, retry
 *        │
 *   engine.startTask: claim in MongoDB                    ── null? ack & drop
 *        │  (QUEUED, or RUNNING with an expired lease = takeover)
 *   extend the Redis lease to the task's own timeout + grace
 *        │
 *   run handler -> report result to MongoDB (engine)
 *        │
 *   ack in Redis   <- ONLY after MongoDB has the result
 *
 * Why ack LAST: if we crash after reporting but before acking, the lease
 * expires, the id is requeued, the next worker's MongoDB claim returns null
 * (task already finished) and it simply acks. The reverse order (ack first)
 * could lose the task if we crashed before reporting.
 *
 * Every worker also runs queue maintenance (reaper + delayed promoter). Those
 * are atomic Lua scripts, so any number of workers can run them concurrently.
 *
 * Polling vs blocking: Lua scripts can't block, so an idle loop polls every
 * `pollIntervalMs`. BLMOVE could block instead, but it can't set a lease
 * deadline in the same atomic step. Idle cost: concurrency / pollInterval
 * requests per second (4 loops at 200ms = 20 req/s), which is negligible for Redis.
 *
 * @param {{
 *   queue: ReturnType<import('../queues/taskQueue.js').createTaskQueue>,
 *   engine: ReturnType<import('../workflow/engine.js').createEngine>,
 *   handlers: Record<string, Function>,
 *   logger: import('pino').Logger,
 *   workerId: string,
 *   concurrency?: number,
 *   pollIntervalMs?: number,
 *   claimLeaseMs?: number,     // Redis lease covering "popped but not yet claimed in MongoDB"
 *   leaseGraceMs?: number,     // added to task.timeoutMs for the running lease
 *   maintenanceIntervalMs?: number,
 * }} deps
 */
export function createQueueWorker({
  queue,
  engine,
  handlers,
  logger,
  workerId,
  concurrency = 4,
  pollIntervalMs = 200,
  claimLeaseMs = 30_000,
  leaseGraceMs = 10_000,
  maintenanceIntervalMs = 1000,
}) {
  const log = logger.child({ workerId });
  let stopping = false;
  let loops = [];
  let maintenanceTimer = null;
  let running = 0;

  async function processTask(taskId) {
    const claimed = await engine.startTask(taskId, workerId);
    if (!claimed) {
      // Finished, cancelled, or held by a live worker: this queue entry is a
      // leftover duplicate. Drop it.
      await queue.ack(taskId);
      return;
    }
    await queue.extendLease(taskId, claimed.task.timeoutMs + leaseGraceMs);
    await runTask({ claimed, engine, handlers, logger: log });
    await queue.ack(taskId);
  }

  async function loop() {
    let backoffMs = pollIntervalMs;
    while (!stopping) {
      let taskId;
      try {
        taskId = await queue.claim(claimLeaseMs);
        backoffMs = pollIntervalMs;
      } catch (err) {
        // Redis unreachable: back off (capped) instead of hammering it.
        log.warn({ err: err.message, backoffMs }, "queue claim failed");
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 5000);
        continue;
      }
      if (!taskId) {
        await sleep(pollIntervalMs);
        continue;
      }
      running += 1;
      try {
        await processTask(taskId);
      } catch (err) {
        // The id is still leased in Redis: if we couldn't finish, the lease
        // expires and the task is retried — nothing is lost.
        log.error({ err: err.message, taskId }, "failed to process task");
      } finally {
        running -= 1;
      }
    }
  }

  async function maintenance() {
    try {
      const [requeued, promoted] = await Promise.all([queue.requeueExpired(), queue.promoteDue()]);
      if (requeued.length) log.warn({ count: requeued.length }, "requeued tasks with expired leases");
      if (promoted.length) log.debug({ count: promoted.length }, "promoted delayed tasks");
    } catch (err) {
      log.warn({ err: err.message }, "queue maintenance failed");
    }
  }

  return {
    start() {
      stopping = false;
      loops = Array.from({ length: concurrency }, () => loop());
      maintenanceTimer = setInterval(maintenance, maintenanceIntervalMs);
      log.info({ concurrency }, "queue worker started");
    },

    /**
     * Graceful stop: stop claiming, let in-flight tasks finish and report.
     * Tasks still in Redis simply stay there for the next worker.
     */
    async stop() {
      stopping = true;
      clearInterval(maintenanceTimer);
      await Promise.allSettled(loops);
      log.info("queue worker stopped");
    },

    stats() {
      return { running, concurrency };
    },
  };
}
