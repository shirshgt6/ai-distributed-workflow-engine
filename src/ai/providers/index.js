import { createOpenAICompatibleProvider } from "./openaiCompatible.js";
import { createMockProvider } from "./mock.js";

/**
 * Build the configured provider. The rest of the system only ever sees the
 * provider INTERFACE (chat / embed), never which one this is.
 *
 * @param {{ provider: "ollama"|"openai-compatible"|"mock", baseUrl: string, apiKey?: string, timeoutMs: number }} llmConfig
 */
export function createProviderFromConfig(llmConfig) {
  if (llmConfig.provider === "mock") {
    // Demo mode without a model: a tiny rule-based responder.
    return createMockProvider({ name: "mock", respond: () => "{}" });
  }
  return createOpenAICompatibleProvider({
    name: llmConfig.provider,
    baseUrl: llmConfig.baseUrl,
    apiKey: llmConfig.apiKey,
    timeoutMs: llmConfig.timeoutMs,
  });
}
