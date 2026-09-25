import { withTimeout } from "../utils/withTimeout.js";

/**
 * Run ONE already-claimed task's handler and report the outcome to the engine.
 *
 * @param {{
 *   claimed: { task, input, parents },   // from engine.startTask()
 *   engine: { completeTask: Function, failTask: Function },
 *   handlers: Record<string, Function>,
 *   logger: import('pino').Logger,
 * }} deps
 */
export async function runTask({ claimed, engine, handlers, logger }) {
  const { task, input, parents } = claimed;
  const taskId = task._id;
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
      // Promise.resolve().then(): a handler that throws synchronously becomes
      // a rejected promise instead of escaping withTimeout.
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
