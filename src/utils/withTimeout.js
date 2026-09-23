export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timer.
 *
 * Reused later for task timeouts and LLM call timeouts. Important caveat
 * (it matters a LOT for workers): this stops us WAITING — it does not stop
 * the underlying work. The original promise keeps running in the background.
 * Real cancellation needs an AbortSignal passed into the work itself.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  // finally(): always clear the timer, otherwise a pending timer keeps
  // the event loop (and the process / a Jest run) alive for `ms`.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
