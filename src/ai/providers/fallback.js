import { ProviderError } from "./errors.js";
import { createCircuitBreaker } from "./circuitBreaker.js";

/**
 * FALLBACK PROVIDER: same interface, several providers behind it, in order.
 *
 * chat():
 *   for each provider whose circuit is not OPEN:
 *     success            -> return it (annotated with provider + fallbackUsed)
 *     RETRYABLE failure  -> record it, try the next provider
 *     NON-retryable      -> throw immediately: a 400 "bad request" will be
 *                           just as bad at the next provider, and falling back
 *                           would only hide the bug
 *   nobody left -> ProviderError(retryable) so the TASK retries later with backoff
 *
 * Each provider may use a different model name for the same tier (e.g.
 * "qwen2.5:0.5b" locally vs "gpt-4o-mini" hosted): `mapModel` translates.
 *
 * embed(): NO fallback, primary only. Vectors from a different embedding
 * model live in a different space: mixing them into the same Qdrant
 * collection would silently corrupt retrieval. Failing is the right call.
 *
 * @param {{ entries: { provider, mapModel?: (m: string) => string }[], breaker?: object, logger }} options
 */
export function createFallbackProvider({ entries, breaker = {}, logger }) {
  const chain = entries.map((e) => ({ ...e, breaker: createCircuitBreaker(breaker) }));

  return {
    name: chain.map((c) => c.provider.name).join(">"),
    chain,

    async chat(request) {
      let lastError = null;
      for (let i = 0; i < chain.length; i++) {
        const { provider, mapModel, breaker: circuit } = chain[i];
        if (!circuit.allow()) {
          lastError = new ProviderError(`${provider.name} circuit open`, { provider: provider.name, retryable: true });
          continue;
        }
        try {
          const model = mapModel ? mapModel(request.model) : request.model;
          const res = await provider.chat({ ...request, model });
          circuit.success();
          if (i > 0) logger?.warn({ provider: provider.name, model }, "LLM fallback provider used");
          return { ...res, provider: provider.name, fallbackUsed: i > 0 };
        } catch (err) {
          if (err?.retryable === false) throw err;
          circuit.failure();
          lastError = err;
          logger?.warn({ provider: provider.name, err: err.message, circuit: circuit.state }, "LLM provider failed");
        }
      }
      throw new ProviderError(`All LLM providers failed: ${lastError?.message ?? "none available"}`, {
        provider: "fallback",
        retryable: true,
        cause: lastError,
      });
    },

    async embed(request) {
      const { provider, breaker: circuit } = chain[0];
      if (!circuit.allow()) throw new ProviderError(`${provider.name} circuit open`, { provider: provider.name, retryable: true });
      try {
        const res = await provider.embed(request);
        circuit.success();
        return { ...res, provider: provider.name, fallbackUsed: false };
      } catch (err) {
        if (err?.retryable !== false) circuit.failure();
        throw err;
      }
    },
  };
}
