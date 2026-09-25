# AI architecture

> Built so far: provider abstraction (13), structured output (14), **classification (15)** and **model routing (16)**.
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

## Classification (`src/ai/classifier.js`), Phase 15
The request (wrapped as `<user_input>`) goes through `generateStructured` into a validated
`{ taskType, complexity, requiresRAG, requiresAgent, recommendedModel, rationale }`.
- **Prompt versioning:** `classifier.v2` is recorded with each result.
- **Fallback:** if the model is unreachable or keeps returning invalid output after repairs, a deterministic keyword
  heuristic is used and the result is marked `source: "heuristic"` with a `fallbackReason`. It never falls back silently.
- **Real-model finding:** with `classifier.v1`, qwen2.5:0.5b classified "According to our company handbook, how many
  vacation days...?" as `requiresRAG: false`. Adding three few-shot examples (`v2`) gave `requiresRAG: true` in 3/3 runs.
  That's a single-query check, **not an accuracy evaluation**. A 0.5B model is weak at classification; production would
  use a larger model and an evaluation set.

## Routing (`src/ai/router.js`), Phase 16
Deterministic rules (first match wins). A second LLM call is deliberately avoided, since rules are free, instant, testable and explainable:

| Rule | Condition | Route |
|---|---|---|
| requires-tools | `requiresAgent` | **agent**, large |
| requires-knowledge | `requiresRAG` | **rag**, small if low complexity, else large |
| high-complexity | complexity high or taskType reasoning | **direct**, large |
| default-small | everything else | **direct**, small (the model can't force "large" on a low-complexity task) |

Cost, latency and quality: the common, simple path uses the cheaper, faster model, and the classification decides when to escalate.
Locally both tiers point at `qwen2.5:0.5b` (only one chat model is installed). The tier names and routing are real, but
there's no cost difference to measure yet.

## AI task handlers (`src/handlers/ai.js`)
`ai.classify`, `ai.route` (reuses a parent's classification, so there's no second LLM call), and `ai.generate`
(uses the parent route's model, and refuses non-direct routes with a clear non-retryable error). They're ordinary workflow
tasks, so dependencies, retries (a `ProviderError.retryable` timeout is retried with backoff), timeouts, cancellation and
events all apply unchanged.
