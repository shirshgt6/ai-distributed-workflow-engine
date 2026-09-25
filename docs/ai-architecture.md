# AI architecture

> Built so far: **provider abstraction (Phase 13)** and **structured output + validation + repair (Phase 14)**.
> Later sections are added as phases land.

## Provider abstraction (`src/ai/providers/`)
```
handlers / RAG / agent  ──depend on──►  PROVIDER INTERFACE
                                          chat({ model, messages, temperature, json, maxTokens, signal })
                                            → { content, model, usage{inputTokens, outputTokens}, latencyMs }
                                          embed({ model, input[] }) → { vectors, usage, latencyMs }
                                                ▲                 ▲
                         createOpenAICompatibleProvider      createMockProvider
                         (Ollama locally; also OpenAI,       (deterministic, for tests
                          vLLM, LM Studio... via fetch)        and LLM_PROVIDER=mock)
```
- **Dependency inversion:** business code depends on the interface, never on Ollama or OpenAI, so swapping providers
  (or testing without a model) changes no business code.
- **No vendor SDK:** two endpoints (`/v1/chat/completions`, `/v1/embeddings`) through `fetch`.
- **Errors are normalised** to `ProviderError { provider, status, retryable }`: network errors, timeouts, 429 and 5xx
  are retryable; 400, 401, 403 and 404 are not. The API key never appears in error messages, and the logger redacts it.
- **Timeouts:** the provider's own `AbortSignal.timeout`, combined with the caller's signal (task timeout or cancel).
- **Models used locally:** `qwen2.5:0.5b` (chat, ~400 MB) and `nomic-embed-text` (768-dimension embeddings). Azure OpenAI is
  **not** supported or tested.

## Structured output (`src/ai/structured.js`)
1. The system prompt includes the task, the untrusted-data rule, and the **JSON Schema generated from the zod schema**.
2. The call runs in **JSON mode** (syntax only) at temperature 0.
3. The output is parsed (tolerating ```json fences and surrounding chatter) and **validated with zod**. Unknown keys are stripped.
4. If it's invalid, the model gets a **repair turn**: its own answer plus the exact parse or field errors. This runs up to `maxRepairs` (2).
5. If it's still invalid, `StructuredOutputError` is thrown, which is **non-retryable** at the task level (the same prompt would fail the same way).

Why validate even with JSON mode: JSON mode guarantees syntax, not field names, enums or types. It's also an injection
defence, because a manipulated model can only return what the schema allows.

## Prompt-injection basics (`src/ai/prompts/safety.js`)
Untrusted text (user input, documents, tool results) is wrapped in named delimiters, and early closing tags are neutralised.
The system prompt says delimited content is data only. This *reduces* injection but doesn't prevent it. The real controls
are schema validation and (Phase 20) allowlisted, permission-checked tools in code.

## Verified against a real model (`npm run test:llm`)
- qwen2.5:0.5b returned schema-valid `{"sentiment":"positive"}` on the first attempt.
- nomic-embed-text: cosine("refund for my order", "refund policy") = 0.777 vs ("refund…", "weather") = 0.369 (one run on a laptop).
