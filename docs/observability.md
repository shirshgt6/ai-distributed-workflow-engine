# Observability (Phase 23, plus what earlier phases already give)

## Logs, metrics, traces: what exists here
| Signal | Implemented | Where |
|---|---|---|
| **Structured logs** | ✅ JSON (pino), secrets redacted, `reqId` on every request line, `userId` once authenticated; worker lines carry `workerId`, `executionId`, `taskKey`, `attempt`; one `llm call` line per LLM call | `src/config/logger.js`, `app.js`, `runTask.js`, `observability.js` |
| **Metrics** | ✅ as queryable MongoDB aggregations (not Prometheus) | `GET /analytics/ai`, `GET /analytics/workflows` |
| **Traces** | ❌ no OpenTelemetry. The substitute is correlation fields (reqId → executionId → taskId → AIExecution) that can be joined across logs and collections | — |

## LLM call records (`AIExecution`)
Every chat and embed call through the provider stack is recorded by a decorator (`createObservedProvider`):
`operation, executionId, taskId, ownerId, taskType, provider, model, status, error, retryable, fallbackUsed, latencyMs,
inputTokens, outputTokens, totalTokens, estimatedCostUsd`. **Prompt and response text are not stored** (user data).

**Attribution without plumbing:** `runTask` runs each handler inside an `AsyncLocalStorage` context
`{ executionId, taskId, ownerId, taskType }`, so a call made deep inside RAG or the agent loop is still attributed to its task.

**Cost:** `LLM_PRICING_JSON` gives USD per 1M input/output tokens per model. Unknown models, including local Ollama models,
cost **0**. This is an estimate from a price table, not a bill.

Recording is fire-and-forget: a failure to write metrics is logged and never fails the task. Rows expire after 90 days.

## Endpoints (`analytics:read`, scoped to own data; admin sees all)
- `GET /analytics/ai?days=7` gives totals (calls, errors, fallbacks, tokens, cost), per provider/model/operation (error rate,
  avg and **p95 latency** via MongoDB `$percentile`, tokens, cost), and per task type.
- `GET /analytics/workflows?days=7` gives executions by status, **success rate**, duration avg/p95, attempts/retries/abandoned
  (crashed-worker takeovers), and the top failing task types.

## Debugging a distributed run: where to look
1. `GET /executions/:id`: task states, attempts, errors.
2. `taskexecutions`: one row per attempt (worker id, ABANDONED = a crashed worker, TIMED_OUT, SUSPENDED = approval).
3. `aiexecutions` by `executionId`: which model, latency, tokens, fallback, error.
4. Logs filtered by `executionId` or `reqId`.
5. `GET /workers`: ACTIVE / UNRESPONSIVE workers.
6. Kafka `workflow-events` / `eventstats`: the lifecycle timeline.

No latency, throughput or cost numbers are claimed for the project. The analytics report what a given deployment measures.
