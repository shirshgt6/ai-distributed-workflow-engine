// Task handlers: the code that actually DOES a task's work, looked up by
// task.type. The engine never imports these; only the executor does.
//
// Every handler receives one object:
//   config  — the task's config from the workflow definition
//   input   — the execution's input (POST /workflows/:id/run body)
//   parents — { [parentKey]: parentOutput } — data flowing along the DAG
//   attempt — 1 for the first try, 2 for the first retry, ...
//   signal  — AbortSignal, fired on timeout; long work should stop when it fires
// and returns a JSON-serialisable output (stored on the task, passed to children).
// Throw NonRetryableError for permanent failures; any other error is retried
// (up to the task's retryPolicy.maxAttempts).
//
// These are deliberately simple built-ins for exercising the engine. Real
// ones (HTTP calls, AI tasks, human approval) arrive in later phases.

import { NonRetryableError } from "../workers/retry.js";
import { AwaitApproval } from "../workers/approval.js";

const DAY_MS = 24 * 3600 * 1000;

const MAX_DELAY_MS = 60_000;

/** Sleep that stops early (rejects) when the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });
}

export const handlers = Object.freeze({
  /** Does nothing, instantly. */
  noop: async () => ({}),

  /** Waits config.ms (default 100, max 60s) — simulates slow work. */
  delay: async ({ config, signal }) => {
    const ms = Math.min(Math.max(Number(config.ms) || 100, 0), MAX_DELAY_MS);
    await sleep(ms, signal);
    return { waitedMs: ms };
  },

  /**
   * Always throws. Permanent (non-retryable) by default, like a business
   * error; config.retryable: true makes it transient, so it's retried until
   * attempts run out and then dead-lettered.
   */
  fail: async ({ config }) => {
    const message = config.message ?? "Task configured to fail";
    if (config.retryable === true) throw new Error(message);
    throw new NonRetryableError(message);
  },

  /** Fails (transiently) on its first config.failTimes attempts, then succeeds. */
  flaky: async ({ config, attempt }) => {
    const failTimes = Number(config.failTimes ?? 1);
    if (attempt <= failTimes) throw new Error(`flaky failure on attempt ${attempt}/${failTimes}`);
    return { succeededOnAttempt: attempt };
  },

  /**
   * HUMAN APPROVAL GATE. Pauses this branch of the run until someone approves
   * or rejects (POST /approvals/:id/approve|reject), or the timeout passes.
   * config: { title?, message?, timeoutMs? (default 24h, max 7 days) }.
   * The approver sees `context`: the outputs of this task's parents (e.g. the
   * AI's recommendation). Output after approval: { approved, decidedBy, comment, decidedAt }.
   */
  "human.approval": async ({ config, parents }) =>
    new AwaitApproval({
      title: String(config.title ?? "Approval required").slice(0, 200),
      message: String(config.message ?? "").slice(0, 2000),
      context: parents,
      timeoutMs: Math.min(Math.max(Number(config.timeoutMs) || DAY_MS, 1000), 7 * DAY_MS),
    }),

  /** Returns what it received — shows data flowing between tasks. */
  echo: async ({ config, input, parents }) => ({ config, input, parents }),
});
