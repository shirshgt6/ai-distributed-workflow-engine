# Revision Sheet: AI Distributed Workflow Engine

Read this the night before (about 20 minutes). For depth see [interview-guide.md](interview-guide.md), and for
real-life stories see [phase-summaries.md](phase-summaries.md).

---

## 1. One-liner + 30-second pitch
**One-liner:** A distributed engine that runs **DAG workflows** (including AI tasks) on scalable workers and survives
crashes without losing or double-completing work.

**Pitch:** "Workflows are DAGs of tasks: normal tasks, LLM classify/route, RAG, a tool-using agent, and human approval.
Independent tasks run in parallel. MongoDB is the truth, Redis is a lease-based queue, and Kafka carries events via an outbox.
State changes are transactions + compare-and-set with fencing tokens. Chaos test: 280 tasks, 14 worker kills + a Redis
restart, every task completed exactly once. 381 tests."

**Kitchen analogy:** orders (workflows) are split into dishes (tasks). Dishes that don't depend on each other are cooked in
parallel by many cooks (workers). The order register (MongoDB) is the truth, the token machine (Redis) tells a cook
which dish is next, and the notice board (Kafka) tells everyone what happened.

---

## 2. Numbers to remember (all real)
| What | Value |
|---|---|
| Automated tests | **381** (35 suites), unit + integration |
| Coverage | **95.0% lines**, 93.2% statements, 78.3% branches |
| Chaos test | **40 runs × 7 tasks = 280 tasks**, **14 worker kills + 1 Redis restart**, every task exactly 1 success |
| Task lease (Mongo) | **15 s** (`LEASE_TTL_MS`); heartbeat renews every **5 s** (TTL/3) |
| Reconciler | every **5 s**, treats something as stale after **10 s** |
| Retry backoff | full jitter: `random(0, min(60s, base·2^(n−1)))` |
| LLM repair turns | up to **2**, then `StructuredOutputError` (non-retryable) |
| RAG | chunk **800 / overlap 100**, nomic embeddings **768-d**, top-K + score threshold |
| API | **27 paths** in OpenAPI 3.1, `/docs` |
| Data | **13 MongoDB collections** |
| Docker image | ~**89 MB**, non-root, one image for 3 roles (api / worker / consumer) |
| Local model | qwen2.5:**0.5b** via Ollama (weak: controls work, answers don't) |

❗ There are **no** throughput or latency benchmark numbers. Don't make any up.

---

## 3. Architecture in 6 lines
1. **API** (Express): auth → RBAC → zod → one **Mongo transaction** creates run + tasks + outbox event → enqueue → **202**.
2. **Redis**: ready LIST, leases ZSET, delayed ZSET, members SET, all through **Lua** (atomic).
3. **Workers** (separate processes): claim → `startTask` (lease + fencing token) → handler → complete/fail → **ack last**.
4. **Engine** = functions, not a process: whoever finishes a task advances the DAG, so there's **no central orchestrator SPOF**.
5. **Background loops** in the worker: reaper/promoter, **reconciler**, **scheduler** (leader), **outbox relay** (leader).
6. **AI layer**: provider interface → fallback + circuit breakers → observed (AIExecution rows). RAG on Qdrant, agent, HITL.

---

## 4. State machines
**Task:** `PENDING → READY → QUEUED → RUNNING → COMPLETED`
- RUNNING → RETRYING → QUEUED (backoff)
- RUNNING → FAILED → DEAD_LETTER
- RUNNING → WAITING_FOR_APPROVAL → COMPLETED/FAILED
- RUNNING → QUEUED (worker died), QUEUED → READY (Redis lost it)
- Anything unfinished → CANCELLED

**Execution:** `PENDING → RUNNING → COMPLETED | FAILED | CANCELLED`, and RUNNING ⇄ PAUSED / WAITING_FOR_APPROVAL.

**Two layers:** the transition table stops **logic bugs** (COMPLETED→READY), and the `{status: from}` filter stops **races**.

---

## 5. Core mechanisms (what → why → analogy)
| # | Mechanism | One-line answer | Kitchen analogy |
|---|---|---|---|
| 1 | **DAG + Kahn's algorithm** | O(V+E); emitted < total ⇒ cycle; waves = parallel levels | a dish can't wait on a dish that waits on it |
| 2 | **Compare-and-set** | `update where status = expected`; 0 matched ⇒ you lost the race | two cooks grab one ticket; only the first one's stamp counts |
| 3 | **Transactions** | task + children + run + event change together or not at all | the register entry and the notice-board slip are written together |
| 4 | **Write skew + `pendingTasks`** | two "last" tasks each saw the other running ⇒ the run never completed. A shared counter forces a conflict | two cooks each think "the other is still cooking", so nobody closes the order. Fix: one counter both must update |
| 5 | **Lease** | ownership until a deadline; renewed by heartbeat | a cook's ticket is valid for 15 s unless they shout "still cooking" |
| 6 | **Fencing token** | `leaseToken` +1 per claim; a stale write with the old token is rejected | the old cook's late plate carries an old token number, so it's thrown away |
| 7 | **Atomic Lua claim** | pop + lease in one script, so an id is never lost in between | taking the ticket and signing the register happen in one motion |
| 8 | **Ack last** | crash before ack ⇒ harmless redelivery; ack first could lose work | tear up the ticket only after the dish is served |
| 9 | **Retry + jitter + DLQ** | transient errors retry with random backoff; `NonRetryableError` fails fast; exhausted ⇒ dead letter | a burnt dish is re-cooked after a random wait, and after 5 fails it goes to the manager's shelf |
| 10 | **Reconciler** | Mongo is truth; it repairs READY/QUEUED/RUNNING/RETRYING stragglers and expired approvals | the manager checks the register every 5 s for forgotten orders |
| 11 | **Idempotency** | run key under a unique index (same → replay, different body → 422); scheduler slot key; consumer processed-event row | the same order slip given twice = one order |
| 12 | **Transactional outbox** | the event row is committed with the state change; the relay publishes later ⇒ at-least-once, consumer dedupes | the slip goes into the outbox with the bill; a runner pins it to the board later |
| 13 | **Distributed lock** | `SET NX PX` + token, compare-and-delete; used for leader election. Correctness comes from idempotency, not the lock | only one manager prints the day's schedule, and even if two do, each slot is printed once |
| 14 | **Graceful shutdown** | SIGTERM ⇒ stop claiming, finish, report, exit | the cook finishes the current dish before going home |
| 15 | **Poison-pill guard** | takeovers count as attempts ⇒ a crashing task ends up in DLQ | a dish that sets the stove on fire every time isn't retried forever |

---

## 6. AI layer: 8 points
1. **Provider interface** (`chat`, `embed`): OpenAI-compatible (Ollama) or mock. Business code never sees the vendor.
2. **Structured output**: JSON schema in the prompt → JSON mode → **zod validate** → **repair ×2** → refuse. JSON mode ≠ schema.
3. **Classifier** (prompt v2 with few-shot examples) → **rule-based router**: tools→agent, docs→RAG, hard→big model, else small.
4. **Fallback chain + circuit breakers** (closed → open → half-open). Fall back only on retryable errors, and **never for embeddings** (different vector space).
5. **RAG**: clean → dedupe → chunk → embed → Qdrant (**ownerId filter inside the query**). Citations are an **enum S1..Sk**, so a fake citation fails validation. No evidence ⇒ a fixed "not enough information" answer with **no LLM call**.
6. **Agent**: the model proposes, **code decides**: allowlist ∩ role, ownerId from context (never from args), zod args, timeouts, max iterations, loop guard, read-only tools, calculator = parser (never `eval`).
7. **Human-in-the-loop**: the task is parked in the DB (no worker held); approve/reject = CAS on PENDING in one transaction ⇒ one winner, the others get 409; the reconciler expires it on timeout.
8. **Observability**: an AIExecution row per call (tokens, latency, cost, fallback) attributed via **AsyncLocalStorage**; no prompt text is stored; `/analytics/ai` shows p95.

---

## 7. Bugs I found (interview stories: problem → cause → fix → lesson)
1. **Write skew:** a run stuck RUNNING → two last tasks in snapshot isolation → `pendingTasks` counter → "transactions ≠ serializable".
2. **Lost retry:** dedupe dropped a retry while the id was still leased, then ack erased it → move leased → delayed; ack only if the lease is still owned.
3. **Login timing leak:** unknown emails answered faster (a lazy dummy hash) → precompute it → equal timing.
4. **Mongoose `minimize`** silently dropped `{}` outputs → `minimize: false`.
5. **Qdrant client upgrade** removed `search` → moved to `query`.
6. **Body limit** blocked document upload → a route-specific 256 KB parser.
7. **Container-only crash**: `create-admin` used pino-pretty (a dev dependency) → disabled in production. Lesson: smoke-test the real container.
8. **Project 1's lost job**: `BZPOPMIN` then a crash = job gone forever → **Project 2 fixes it** with the atomic Lua pop + lease.

---

## 8. Failure scenarios: quick answers
| Kya hua | Kya hota hai |
|---|---|
| Worker `kill -9` mid-task | heartbeat stops → takeover within ≤15 s → zombie's report fenced |
| Crash after commit, before enqueue | reconciler dispatches the READY task |
| Redis restarted / wiped | reconciler rebuilds from Mongo (chaos-tested) |
| Redis down on `/run` | still 202; enqueued later. Login ⇒ 503 (fail closed) |
| Kafka down | events wait in the outbox; tasks unaffected |
| LLM down / bad JSON | fallback + breaker / repair turns / non-retryable fail |
| Two approvers at once | one wins, the other gets 409 |
| Two schedulers | one run per slot (idempotency key) |

---

## 9. Trade-off one-liners
- **Redis vs Kafka for tasks:** Kafka has no per-message ack, visibility timeout or delay, and blocks head-of-line → Redis for tasks, Kafka for events.
- **Why not Mongo as the queue:** idle workers would poll the primary; Redis pop + lease is atomic in memory.
- **Temporal / BullMQ exist:** I built the core to understand leases, fencing, outbox and write skew; Temporal is the production-grade version.
- **Rules vs LLM router:** free, instant, testable, explainable.
- **At-least-once + apply-once**, not exactly-once: external side effects can't be committed atomically with our DB.
- **Fail-fast per run** (no "continue other branches" option).
- **Scaling next:** Redis Cluster/Sentinel, shard Mongo by executionId, sharded counter for huge fan-out, more Kafka partitions, Qdrant replicas.

---

## 10. ❌ Never claim
Exactly-once · any throughput/latency number · HA/production deployment · AI accuracy numbers · Azure/OpenAI tested
(only local Ollama) · OpenTelemetry/Prometheus · PDF ingestion, re-ranking, hybrid search · refresh-token rotation *in Project 2*
· "LangChain agents" (only the text splitter).

---

## 11. Project 1 vs Project 2 (interviewers compare them)
| | Project 1: Job Queue | Project 2: Workflow Engine |
|---|---|---|
| Unit of work | single job | DAG of tasks with dependencies |
| Claim | `BZPOPMIN` (crash after pop = lost job) | Lua pop + lease (never lost) |
| Stale-write protection | `lockedBy` owner check | owner + **fencing token** (`leaseToken`) |
| State changes | single-document conditional updates | **transactions** + CAS |
| Kafka | fire-and-forget (events can be lost) | **transactional outbox** + idempotent consumer |
| AI | Claude API: summarize/classify/extract + fallback | provider interface, router, RAG, agent, HITL, breakers, cost tracking |
| Auth | JWT + **rotating hashed refresh tokens** | JWT + tokenVersion + RBAC + Redis sliding-window limits |
| Tests | none automated | 381 + chaos test |

**Story line:** "Project 1 taught me where queues lose work, and Project 2 is the redesign that fixes each of those gaps."

---

## 12. Last-minute rapid fire (answer in one breath)
1. Cycle detection? Kahn: emitted < total.
2. CAS? Update conditional on the expected value.
3. Fencing token? A counter per claim; stale writes are rejected.
4. Why ack last? Redelivery is safe, loss isn't.
5. Why jitter? It de-synchronises retry storms.
6. Write skew? Disjoint writes break a shared invariant.
7. Outbox? The event is committed with the state change.
8. At-least-once vs exactly-once? Delivery repeats; the effect applies once.
9. Lock enough for correctness? No, a paused holder outlives its TTL; use idempotency and fencing.
10. RAG hallucination control? Threshold, citation enum, refusal without evidence.
11. Agent safety? Allowlist, role, context-scoped ownerId, zod, timeouts, loop guard.
12. Fallback for embeddings? Never: different vector space.
13. 404 not 403 for others' data? Don't reveal existence (BOLA).
14. Liveness vs readiness? Alive vs able to serve.
15. What next? HA infra, OpenTelemetry, a bigger model + RAG eval set, cursor pagination, per-tenant quotas.
