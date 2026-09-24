import { withTimeout } from "../utils/withTimeout.js";

/**
 * IN-PROCESS EXECUTOR (Phase 5 only).
 *
 * Runs tasks inside the API process with a concurrency limit. It exists so the
 * engine can be built and understood before adding Redis (Phase 6) and
 * separate worker processes (Phase 7) — it plugs into the same `enqueue`
 * interface those will use.
 *
 * Its queue is an in-memory array, so it has the obvious weakness: if the
 * process dies, queued work is forgotten. The DB still says QUEUED/RUNNING,
 * which is why engine.recoverInProcessOrphans() runs at startup. That weakness
 * is exactly what the Redis queue fixes.
 *
 * @param {{
 *   handlers: Record<string, Function>,
 *   concurrency: number,
 *   logger: import('pino').Logger,
 *   workerId?: string,
 * }} deps
 */
export function createInProcessExecutor({ handlers, concurrency, logger, workerId = `inproc-${process.pid}` }) {
  const queue = [];
  const inFlight = new Set();
  let engine = null;
  let stopping = false;

  // CONCURRENCY LIMIT: start at most `concurrency` tasks at once. When one
  // finishes, pump() starts the next. Without a limit, a 100-task wave
  // would start 100 handlers at once and could exhaust memory/sockets.
  function pump() {
    while (!stopping && inFlight.size < concurrency && queue.length > 0) {
      const item = queue.shift();
      const run = execute(item)
        .catch((err) => logger.error({ err, taskId: item.taskId }, "executor failed to process task"))
        .finally(() => {
          inFlight.delete(run);
          pump();
        });
      inFlight.add(run);
    }
  }

  async function execute({ taskId }) {
    const claimed = await engine.startTask(taskId, workerId);
    if (!claimed) return; // cancelled, or already claimed elsewhere — nothing to do

    const { task, input, parents } = claimed;
    const log = logger.child({ executionId: String(task.executionId), taskKey: task.key, attempt: task.attempt });
    const handler = handlers[task.type];
    const controller = new AbortController();

    // Run the handler. Its result is reported OUTSIDE this try/catch: if
    // reporting itself fails (e.g. Mongo down), that must not be mistaken for
    // "the task failed" and reported a second time.
    let output;
    let failure = null;
    const started = Date.now();
    try {
      if (!handler) throw new Error(`No handler registered for task type "${task.type}"`);
      output = await withTimeout(
        // Promise.resolve().then(): a handler that throws synchronously is
        // turned into a rejected promise instead of escaping withTimeout.
        Promise.resolve().then(() => handler({ config: task.config ?? {}, input, parents, signal: controller.signal })),
        task.timeoutMs,
        `task "${task.key}"`
      );
    } catch (err) {
      failure = err;
      // withTimeout stops WAITING; abort() asks the handler to stop WORKING.
      controller.abort(err);
    }

    const latencyMs = Date.now() - started;
    if (failure) {
      log.warn({ err: failure.message, latencyMs }, "task failed");
      await engine.failTask({ taskId, leaseToken: task.leaseToken, error: failure });
    } else {
      log.info({ latencyMs }, "task completed");
      await engine.completeTask({ taskId, leaseToken: task.leaseToken, output: output ?? null });
    }
  }

  return {
    /** Wire the engine in after both exist (they reference each other). */
    attach(e) {
      engine = e;
    },

    /** Called by the engine when a task becomes QUEUED. */
    enqueue(item) {
      if (stopping) return; // stays QUEUED in the DB; recovered on next start
      queue.push(item);
      pump();
    },

    /**
     * Graceful shutdown: accept nothing new, drop the in-memory backlog (those
     * tasks remain QUEUED in MongoDB), wait for running handlers to report.
     */
    async stop() {
      stopping = true;
      queue.length = 0;
      await Promise.allSettled([...inFlight]);
    },

    stats() {
      return { queued: queue.length, running: inFlight.size, concurrency };
    },
  };
}
