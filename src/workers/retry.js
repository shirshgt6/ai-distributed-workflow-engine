// Retry policy building blocks: which errors deserve a retry, and how long to wait.

/**
 * Throw this from a handler when retrying cannot help: bad input, a business
 * rule ("card declined"), a missing handler. Retrying these only wastes
 * capacity and delays the inevitable failure.
 *
 * Everything else (network errors, timeouts, 5xx from a dependency) is
 * treated as TRANSIENT — worth another attempt.
 */
export class NonRetryableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NonRetryableError";
    this.retryable = false;
  }
}

/** Retry by default; opt out with NonRetryableError or `err.retryable = false`. */
export function isRetryable(err) {
  if (err instanceof NonRetryableError) return false;
  return err?.retryable !== false;
}

/**
 * EXPONENTIAL BACKOFF WITH FULL JITTER.
 *
 *   cap   = min(maxDelayMs, baseDelayMs * 2^(attempt - 1))   -> 1s, 2s, 4s, 8s ...
 *   delay = random(0, cap)
 *
 * Why exponential: a struggling dependency gets progressively more breathing
 * room instead of being hammered at a constant rate.
 *
 * Why JITTER: if 1,000 tasks fail together (the dependency blipped), plain
 * exponential backoff retries all 1,000 at exactly the same instants — a
 * synchronized "retry storm" that knocks the dependency over again. Random
 * spreading turns the spikes into a smooth trickle. ("Full jitter" is the
 * variant described in the AWS Architecture Blog's backoff article.)
 *
 * @param {number} attempt the attempt that just failed (1 = first try)
 * @param {number} baseDelayMs
 * @param {{ maxDelayMs?: number, random?: () => number }} [options] random is injectable for tests
 * @returns {number} milliseconds to wait before the next attempt
 */
export function computeBackoff(attempt, baseDelayMs, { maxDelayMs = 60_000, random = Math.random } = {}) {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const cap = Math.min(maxDelayMs, exponential);
  return Math.floor(random() * cap);
}
