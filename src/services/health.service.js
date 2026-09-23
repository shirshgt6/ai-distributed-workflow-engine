import { withTimeout } from "../utils/withTimeout.js";

/**
 * Run all dependency checks IN PARALLEL, each with its own timeout.
 *
 * Parallel: readiness latency = slowest check, not the sum of all checks.
 * Per-check timeout: a hung dependency (e.g. Mongo not answering) must make
 * the probe say "down" quickly — a readiness probe that itself hangs is
 * useless to a load balancer.
 *
 * @param {Record<string, () => Promise<void>>} checks name -> async fn that throws when unhealthy
 * @param {number} timeoutMs
 * @returns {Promise<{ ready: boolean, results: Record<string, { status: 'up'|'down', latencyMs: number, error?: Error }>}>}
 */
export async function runHealthChecks(checks, timeoutMs) {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      const started = performance.now();
      try {
        await withTimeout(check(), timeoutMs, `${name} health check`);
        return [name, { status: "up", latencyMs: elapsed(started) }];
      } catch (error) {
        return [name, { status: "down", latencyMs: elapsed(started), error }];
      }
    })
  );

  const results = Object.fromEntries(entries);
  const ready = Object.values(results).every((r) => r.status === "up");
  return { ready, results };
}

function elapsed(started) {
  return Math.round(performance.now() - started);
}
