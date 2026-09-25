import { ProviderError, isRetryableStatus } from "./errors.js";

/**
 * LLM PROVIDER for any OpenAI-compatible HTTP API: Ollama (local, used in this
 * project), OpenAI, vLLM, LM Studio... It uses plain `fetch`, with no vendor SDK:
 * the two endpoints we need are simple, and one less dependency is one less
 * thing to pin.
 *
 * THE PROVIDER INTERFACE (every provider implements exactly this):
 *   name
 *   chat({ model, messages, temperature?, json?, maxTokens?, signal? })
 *     -> { content, model, usage: { inputTokens, outputTokens }, latencyMs }
 *   embed({ model, input: string[], signal? })
 *     -> { vectors: number[][], model, usage: { inputTokens }, latencyMs }
 *
 * The workflow engine and handlers depend on THIS interface, never on Ollama
 * or OpenAI directly (dependency inversion), so swapping or adding a provider
 * (or a mock in tests) touches no business code.
 *
 * @param {{ name: string, baseUrl: string, apiKey?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 */
export function createOpenAICompatibleProvider({ name, baseUrl, apiKey, timeoutMs = 60_000, fetchImpl = fetch }) {
  async function post(path, body, signal) {
    // Our own timeout, combined with the caller's AbortSignal (task timeout / cancel).
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      const timedOut = timeout.aborted;
      throw new ProviderError(timedOut ? `${name} timed out after ${timeoutMs}ms` : `${name} unreachable: ${err.message}`, {
        provider: name,
        retryable: true,
        cause: err,
      });
    }
    if (!res.ok) {
      // Never include the API key or full request in errors (they get logged).
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(`${name} HTTP ${res.status}: ${detail}`, {
        provider: name,
        status: res.status,
        retryable: isRetryableStatus(res.status),
      });
    }
    return { json: await res.json(), latencyMs: Date.now() - started };
  }

  return {
    name,

    async chat({ model, messages, temperature = 0, json = false, maxTokens, signal }) {
      const { json: r, latencyMs } = await post(
        "/v1/chat/completions",
        {
          model,
          messages,
          temperature,
          ...(maxTokens && { max_tokens: maxTokens }),
          // JSON mode: the server constrains output to syntactically valid JSON.
          // It does NOT guarantee the JSON matches our schema: that's what
          // validation + repair (src/ai/structured.js) is for.
          ...(json && { response_format: { type: "json_object" } }),
        },
        signal
      );
      return {
        content: r.choices?.[0]?.message?.content ?? "",
        model: r.model ?? model,
        usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
        latencyMs,
      };
    },

    async embed({ model, input, signal }) {
      const { json: r, latencyMs } = await post("/v1/embeddings", { model, input }, signal);
      return {
        vectors: r.data.map((d) => d.embedding),
        model: r.model ?? model,
        usage: { inputTokens: r.usage?.prompt_tokens ?? 0 },
        latencyMs,
      };
    },
  };
}
