import { AsyncLocalStorage } from "node:async_hooks";

/**
 * LLM OBSERVABILITY.
 *
 * Every chat/embed call is recorded as an AIExecution row: provider, model,
 * latency, tokens, estimated cost, fallback used, success/error, AND which
 * workflow task caused it. Where does "which task" come from, when the
 * provider is called deep inside RAG or the agent loop? AsyncLocalStorage:
 * runTask() opens a context { executionId, taskId, ownerId, taskType } and
 * every async call made while that handler runs can read it, without
 * threading parameters through every function. (Same idea as a request
 * correlation id, per task.)
 */
export const aiContext = new AsyncLocalStorage();

/** Run fn with an AI-observability context (used by runTask). */
export function withAiContext(context, fn) {
  return aiContext.run(context, fn);
}

/**
 * Cost estimate from a price table: { [model]: { inputPer1M, outputPer1M } } in USD.
 * Unknown models (incl. local Ollama models) cost 0: local inference has no
 * per-token price. The estimate is only as good as the table.
 */
export function estimateCostUsd(pricing, model, inputTokens, outputTokens) {
  const p = pricing?.[model];
  if (!p) return 0;
  return Number((((inputTokens * p.inputPer1M) + (outputTokens * p.outputPer1M)) / 1e6).toFixed(8));
}

/**
 * Decorator: wraps any provider, records every call. Recording failures are
 * logged and swallowed: observability must never break the actual work.
 *
 * @param {object} provider any provider (incl. the fallback provider)
 * @param {{ AIExecution, pricing?: object, logger }} deps
 */
export function createObservedProvider(provider, { AIExecution, pricing = {}, logger }) {
  async function observe(operation, request, call) {
    const ctx = aiContext.getStore() ?? {};
    const started = Date.now();
    let res;
    let error = null;
    try {
      res = await call();
      return res;
    } catch (err) {
      error = err;
      throw err;
    } finally {
      const inputTokens = res?.usage?.inputTokens ?? 0;
      const outputTokens = res?.usage?.outputTokens ?? 0;
      const record = {
        operation,
        executionId: ctx.executionId ?? null,
        taskId: ctx.taskId ?? null,
        ownerId: ctx.ownerId ?? null,
        taskType: ctx.taskType ?? null,
        provider: res?.provider ?? provider.name,
        model: res?.model ?? request.model,
        status: error ? "error" : "success",
        error: error ? String(error.message).slice(0, 300) : null,
        retryable: error ? error.retryable !== false : null,
        fallbackUsed: Boolean(res?.fallbackUsed),
        latencyMs: Date.now() - started,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCostUsd: estimateCostUsd(pricing, res?.model ?? request.model, inputTokens, outputTokens),
      };
      logger?.info({ ai: record }, "llm call");
      AIExecution.create(record).catch((err) => logger?.warn({ err: err.message }, "could not record AI call"));
    }
  }

  return {
    ...provider,
    name: provider.name,
    chat: (request) => observe("chat", request, () => provider.chat(request)),
    embed: (request) => observe("embed", request, () => provider.embed(request)),
  };
}
