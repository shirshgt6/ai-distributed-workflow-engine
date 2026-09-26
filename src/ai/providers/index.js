import { createOpenAICompatibleProvider } from "./openaiCompatible.js";
import { createMockProvider } from "./mock.js";
import { createFallbackProvider } from "./fallback.js";
import { createObservedProvider } from "../observability.js";

/**
 * Build the provider stack from config:
 *
 *   observed( fallback( [primary, optional secondary], circuit breakers ) )
 *
 * The rest of the system only ever sees the provider INTERFACE (chat / embed):
 * not which vendor, not whether there's a fallback, not the metrics.
 *
 * @param {object} llmConfig config.llm
 * @param {{ AIExecution, logger }} deps
 */
export function createProviderFromConfig(llmConfig, { AIExecution, logger }) {
  const primary =
    llmConfig.provider === "mock"
      ? createMockProvider({ name: "mock", respond: () => "{}" }) // demo mode without a model
      : createOpenAICompatibleProvider({
          name: llmConfig.provider,
          baseUrl: llmConfig.baseUrl,
          apiKey: llmConfig.apiKey,
          timeoutMs: llmConfig.timeoutMs,
        });

  const entries = [{ provider: primary }];
  if (llmConfig.fallback) {
    entries.push({
      provider: createOpenAICompatibleProvider({
        name: "fallback",
        baseUrl: llmConfig.fallback.baseUrl,
        apiKey: llmConfig.fallback.apiKey,
        timeoutMs: llmConfig.timeoutMs,
      }),
      // The secondary serves every tier with its own model name.
      mapModel: () => llmConfig.fallback.model,
    });
  }

  const resilient = createFallbackProvider({ entries, breaker: llmConfig.breaker, logger });
  return createObservedProvider(resilient, { AIExecution, pricing: llmConfig.pricing, logger });
}
