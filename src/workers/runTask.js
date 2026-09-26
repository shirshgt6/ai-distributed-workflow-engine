import { withTimeout } from "../utils/withTimeout.js";
import { NonRetryableError } from "./retry.js";
import { AwaitApproval } from "./approval.js";

/**
 * Run ONE already-claimed task's handler and report the outcome to the engine.
 *
 * @param {{
 *   claimed: { task, input, parents },   // from engine.startTask()
 *   engine: { completeTask: Function, failTask: Function },
 *   handlers: Record<string, Function>,
 *   logger: import('pino').Logger,
 *   signal?: AbortSignal,   // fired by the worker when the lease is lost (takeover / cancel)
 * }} deps
 */
export async function runTask({ claimed, engine, handlers, logger, signal }) {
  const { task, input, parents } = claimed;
  const taskId = task._id;
  const log = logger.child({ executionId: String(task.executionId), taskKey: task.key, attempt: task.attempt });
  const handler = handlers[task.type];
  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });

  // Run the handler. Its result is reported OUTSIDE this try/catch: if
  // reporting itself fails (e.g. Mongo down), that must not be mistaken for
  // "the task failed" and reported a second time.
  let output;
  let failure = null;
  const started = Date.now();
  try {
    // Retrying can't make a missing handler appear: fail permanently.
    if (!handler) throw new NonRetryableError(`No handler registered for task type "${task.type}"`);
    output = await withTimeout(
      // Promise.resolve().then(): a handler that throws synchronously becomes
      // a rejected promise instead of escaping withTimeout.
      Promise.resolve().then(() =>
        handler({
          config: task.config ?? {},
          input,
          parents,
          attempt: task.attempt,
          ownerId: String(task.ownerId), // whose data this run may touch (RAG, agent tools)
          signal: controller.signal,
        })
      ),
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
  } else if (output instanceof AwaitApproval) {
    log.info({ latencyMs }, "task waiting for human approval");
    await engine.suspendForApproval({ taskId, leaseToken: task.leaseToken, request: output.request });
  } else {
    log.info({ latencyMs }, "task completed");
    await engine.completeTask({ taskId, leaseToken: task.leaseToken, output: output ?? null });
  }
}
