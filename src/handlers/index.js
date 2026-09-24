// Task handlers: the code that actually DOES a task's work, looked up by
// task.type. The engine never imports these; only the executor does.
//
// Every handler receives one object:
//   config  — the task's config from the workflow definition
//   input   — the execution's input (POST /workflows/:id/run body)
//   parents — { [parentKey]: parentOutput } — data flowing along the DAG
//   signal  — AbortSignal, fired on timeout; long work should stop when it fires
// and returns a JSON-serialisable output (stored on the task, passed to children).
//
// These are deliberately simple built-ins for exercising the engine. Real
// ones (HTTP calls, AI tasks, human approval) arrive in later phases.

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

  /** Always throws — exercises the failure path. */
  fail: async ({ config }) => {
    throw new Error(config.message ?? "Task configured to fail");
  },

  /** Returns what it received — shows data flowing between tasks. */
  echo: async ({ config, input, parents }) => ({ config, input, parents }),
});
