# Progress

Only phases marked ✅ are implemented. Everything else is planned.

| # | Phase | Status |
|---|---|---|
| 1 | Project architecture + configuration | ✅ |
| 2 | Authentication + RBAC | ✅ |
| 3 | Workflow and task domain models | ✅ |
| 4 | DAG validation | ✅ |
| 5 | Workflow execution engine | ✅ |
| 6 | Redis task scheduling | ✅ |
| 7 | Distributed workers | ✅ |
| 8 | Concurrency + retries + backoff | ✅ |
| 9 | Idempotency + distributed locks | ✅ |
| 10 | Worker heartbeat + crash recovery | ✅ |
| 11 | Kafka event architecture (transactional outbox) | ✅ |
| 12 | Scheduled workflows | ✅ |
| 13 | LLM provider abstraction | ✅ |
| 14 | Structured output + validation | ✅ |
| 15 | AI task classification | ✅ |
| 16 | AI model routing | ✅ |
| 17 | RAG ingestion pipeline | ✅ |
| 18 | Qdrant retrieval | ✅ |
| 19 | LangChain.js integration | ✅ |
| 20 | Controlled AI agents + tools | ✅ |
| 21 | Human-in-the-loop | ✅ |
| 22 | AI retry/fallback | ✅ |
| 23 | LLM observability + analytics | ✅ |
| 24 | Security hardening | ✅ |
| 25 | Testing hardening (chaos tests) | ⬜ |
| 26 | Docker Compose for app services | ⬜ |
| 27 | Swagger + documentation | ⬜ |
| 28 | Final production review | ⬜ |

## Phase 1 — Project architecture + configuration ✅

**Implemented**
- zod-validated config (`src/config/env.js`), reports all invalid vars, never echoes values
- pino structured logging with redaction; pino-http request logs; `X-Request-Id` correlation
- `/health` liveness, `/ready` readiness (parallel checks, 2s per-check timeout, 503 when shutting down)
- Uniform error format `{ error: { code, message, requestId } }`; 404, 400 invalid JSON, 413 body too large, generic 500
- helmet security headers, `x-powered-by` disabled, JSON body limit
- Graceful shutdown (SIGTERM/SIGINT) with force-exit timeout
- Docker Compose: MongoDB 7 single-node replica set (port 27018), Redis 7 with AOF + noeviction (port 6380)

**Tests**: 24 unit, 3 integration.

**Smoke-tested manually**: health/ready, 404, invalid JSON, Redis stopped → `/ready` 503 while `/health` stays 200,
Redis restarted → recovers to 200, SIGTERM → clean shutdown, invalid config → exit 1, unreachable Mongo → exit 1.

**Bug found during smoke test**: ioredis connection errors are `AggregateError`s with an empty `message`,
so outage logs showed `err: ""`. Fixed by also logging `err.code` (`ECONNREFUSED`).

## Phase 2 — Authentication + RBAC ✅

**Implemented**
- `User` model (unique email, `passwordHash` with `select:false`, role, `tokenVersion`)
- bcrypt password hashing (bcryptjs, cost 12); 72-byte limit enforced
- JWT access (15m) + refresh (7d) tokens, separate secrets, `type` claim, HS256 pinned
- Revocation via `tokenVersion` (logout = all devices; role change also revokes)
- RBAC: `admin` / `operator` / `viewer`, permission table in `src/auth/permissions.js`, `requirePermission()` middleware
- zod `validate()` middleware — allowlist parsing into `req.valid` (mass-assignment defence)
- Endpoints: register, login, refresh, logout, me, `PATCH /users/:id/role`
- `npm run create-admin` bootstrap script (credentials from env vars)
- User enumeration defences: identical error + equalised timing via a dummy hash
- JWT secret validation: >= 32 chars, distinct, placeholders refused in production

**Tests**: 83 total (unit: env, permissions matrix, tokens incl. forged/tampered/alg-none/expired,
passwords incl. 72-byte truncation, schemas; integration: full auth flows, RBAC, concurrent
duplicate registration -> exactly one 201).

**Mutation check**: deliberately injected 3 security bugs (operator gets `user:manage`; refresh
ignores `tokenVersion`; raw body passed through) — each was caught by failing tests, then reverted.

**Bug found during smoke test**: the dummy hash for timing equalisation was computed lazily, so
the FIRST unknown-email login took ~2x longer (~400ms vs ~200ms, measured locally with curl) — a
timing leak. Fixed by computing it eagerly at startup; re-measured: both paths ~200ms.
(Local sanity check, not a benchmark.)

**Not done / deferred**: ownership checks (Phase 3), login rate limiting (Phase 24), refresh-token
rotation with reuse detection (documented as a production improvement in docs/security.md).

## Phase 3 — Workflow and task domain models ✅

**Implemented**
- Explicit state machines for executions and tasks (`src/workflow/states.js`): transition tables,
  terminal states, `assertTransition` / `InvalidTransitionError`
- `transitionTask(id, from, to, {set, inc, where, session})` — compare-and-set on status, supports
  fencing via `where: { leaseOwner, leaseToken }` (`src/repositories/task.repository.js`)
- Models: `Workflow` (embedded task definitions, `version`), `WorkflowExecution` (version snapshot),
  `Task` (one doc per task: dependency counters, lease + fencing token), `TaskExecution` (one doc per attempt)
- Workflow CRUD API: create / list (paginated) / get / update
- Ownership (`ownerScope`) on every workflow query — foreign workflow = 404
- Optimistic concurrency on workflow edits (`version` in filter + `$inc`) — stale edit = 409
- Shape validation for workflow definitions (limits on tasks, dependencies, retries, timeouts)

**Tests**: 124 total. New: state-machine matrix, schema limits, workflow CRUD + RBAC + ownership,
5 concurrent edits -> exactly one wins, 10 concurrent task completions -> exactly one wins,
complete-vs-cancel race, stale fencing token rejected, unique indexes.

**Mutation check**: removed the ownership scope, the version condition, the status condition, and
made COMPLETED non-terminal — each was caught by failing tests, then reverted.

**Smoke-tested** on the real server: operator creates (201 + Location), another operator gets 404,
stale edit gets 409 with `currentVersion`, list is scoped, request logs carry `userId`.

**Not done / deferred**: executions and tasks are modelled but not yet created by any endpoint (Phase 5).

## Phase 4 — DAG validation ✅

**Implemented**
- `src/workflow/dag.js`: `validateDag`, `kahn` (topological order + parallel levels), `findCycle` (3-colour DFS)
- Rejects duplicate keys, self-dependency, unknown dependency, duplicate dependency entries, cycles —
  all errors reported at once; cycles reported as a path in execution direction
- Enforced on every workflow create AND update (400 `INVALID_WORKFLOW_GRAPH`, nothing stored)
- `POST /workflows/validate` dry run returning order, levels and critical path length (in tasks)

**Tests**: 150 total. New: 26 (diamond, chains, disconnected graphs, input-order independence, topological
property check, 100-task chain, 2- and 3-node cycles, cycle behind a valid prefix, each structural error,
all-errors-at-once, integration for create/update/validate).

**Mutation check**: disabled cycle detection; removed the duplicate-dependency check; removed validation from
the update path — each caught by failing tests, then reverted.

**Smoke-tested**: the brief's document pipeline validates with `classify` and `retrieve` in the same parallel
level; a body with three different graph errors returns all three messages.

## Phase 5 — Workflow execution engine ✅

**Implemented**
- `src/workflow/engine.js`: `startExecution` (one transaction: execution + all tasks), `dispatchReady`,
  `startTask`, `completeTask` / `failTask` (transactions), `reconcileStuckReady`, `recoverInProcessOrphans`
- `pendingTasks` counter on the execution to prevent write skew between concurrently finishing last tasks
- Fail-fast failure policy; timeouts with AbortSignal; attempt history in `TaskExecution`
- Data flow: handlers get `{ config, input, parents, signal }`
- In-process executor with a concurrency limit and graceful stop (`src/workflow/inProcessExecutor.js`)
- Built-in handlers: noop, delay, fail, echo
- API: `POST /workflows/:id/run` (202 + Location), `GET /executions/:id`, both owner-scoped
- Reconciler interval + startup orphan recovery wired into `server.js`; executor drained on shutdown

**Tests**: 183 total (33 new), suite run 4x with no flaky failures. Includes: diamond race (5 rounds, D dispatched
once), write-skew race (5 rounds), duplicate and stale reports, rollback of a half-created run, fail-fast, reconciler
vs dispatch race, restart recovery with fencing, and an HTTP end-to-end test that asserts B and C overlapped in time
and D started after both.

**Mutation check**: removing fencing, the dispatch CAS, or the start transaction were each caught. The naive
count-based completion check was shown to leave the execution stuck RUNNING (write skew). **One mutant survived**:
removing the "execution still RUNNING" guard before promoting children. It's redundant today, because fail-fast has
already cancelled every PENDING task and promotion only matches PENDING. It's kept as defence in depth and noted here
honestly.

**Bugs found**
- Mongoose `minimize` silently dropped empty objects from task outputs (`{ config: {} }` became `{}`). Fixed with
  `minimize: false` on tasks; caught by the e2e test.
- Mongoose 9 deprecates `{ new: true }`; replaced with `returnDocument: "after"` everywhere.

**Smoke-tested**: a real run completes; `kill -9` during B/C followed by a restart re-runs them as attempt 2 and the
execution completes.

**Known limitations (by design for this phase)**: tasks run inside the API process (Redis queue in Phase 6, workers
in Phase 7); no retries (Phase 8); orphan recovery is only correct with a single executing process (Phase 10 leases);
no pause/resume/cancel endpoints yet; no idempotency key on `/run` (a double click starts two runs, Phase 9).

> Note: Phase 5's in-process executor and `recoverInProcessOrphans` were **replaced in Phase 6** by the Redis queue,
> the queue worker, lease takeover and the 3-sweep reconciler.

## Phase 6 — Redis task scheduling ✅

**Implemented**
- `src/queues/taskQueue.js`: ready LIST, leases ZSET, delayed ZSET, members SET. Lua scripts for enqueue (dedupe),
  claim (pop + lease), extendLease, ack, requeueExpired (reaper) and enqueueDelayed/promoteDue. Times come from Redis `TIME`
- `claimTask` (MongoDB): QUEUED, or RUNNING with an expired lease (takeover). Pipeline update using `$$NOW`, which bumps
  attempt and leaseToken and sets `leaseExpiresAt = now + timeoutMs + grace`. The previous attempt is marked ABANDONED
- `src/workers/queueWorker.js`: N claim loops, lease extension, run → report → **ack last**, exponential backoff
  when Redis is down, reaper and promoter every second. `src/workers/runTask.js` holds the handler, timeout, abort and report
- Engine: a Redis failure at dispatch no longer fails the request. `reconcile()` runs 3 sweeps (stale READY, stale QUEUED,
  expired RUNNING)
- Config: `WORKER_CONCURRENCY`, `QUEUE_POLL_INTERVAL_MS`, `QUEUE_CLAIM_LEASE_MS`, `LEASE_GRACE_MS`
- Removed: the in-process executor and startup orphan recovery

**Tests**: 204 total. New: queue (FIFO, dedupe, 50 concurrent claims over 20 tasks, lease expiry, extend and reaped
extend, concurrent reapers and promoters, delayed), worker (ack-last ordering, no ack when reporting fails, backoff,
concurrency, graceful stop), engine (live lease blocks claim, takeover with ABANDONED + fencing, lease maths, Redis down
at dispatch, reconciler sweeps), end-to-end recovery (pop-then-die, die mid-task, Redis data wiped).

**Mutation check**: claim without a lease (Project 1 behaviour), enqueue without dedupe, ack before report, no takeover,
no token bump. All 5 were caught.

**Smoke-tested on the real server**
- `kill -9` while B and C were running: after restart they stayed RUNNING until their leases expired (3s timeout + 1s
  grace), then were taken over as attempt 2, and the run completed.
- Redis stopped before `POST /run`: 202 returned, A stayed QUEUED; after Redis restarted, the reconciler enqueued it and
  the run completed.

**Known limitations**: the worker runs in the API process (Phase 7); no heartbeat, so leases are fixed at timeout + grace
(Phase 10); no retry or takeover limit (Phase 8); single Redis node.

## Phases 7–8 + idempotent runs ✅ (built in one fast-track session)

**Implemented**
- `src/worker.js`: separate worker process (`npm run worker`) running the queue worker, reconciler and graceful
  SIGTERM drain. The API no longer executes tasks
- Retries: `src/workers/retry.js` (`NonRetryableError`, `isRetryable`, `computeBackoff` with full jitter). `failTask`
  decides between RETRYING, FAILED and DEAD_LETTER. RETRYING is claimable. There's a poison-pill guard (attempts past
  `maxAttempts` after takeovers are dead-lettered), and the reconciler recovers lost retry wake-ups
- Handlers get `attempt`. New `flaky` handler. `fail` is non-retryable unless `config.retryable: true`
- Idempotent `POST /workflows/:id/run` through the `Idempotency-Key` header (unique partial index on the execution)

**Bug found by the new tests**: when a task failed, the engine scheduled its retry into the Redis delayed set, but
the id was still leased and a member, so dedupe dropped it, and the worker's `ack` then removed the membership.
The retry was lost (only the reconciler could rescue it). The fix: `enqueueDelayed` moves a leased id from leases
to delayed, and `ack` only clears membership if the lease still exists. Regression tests were added.

**Tests**: 225 total, suite run twice with no flaky failures. Mutation check: removing jitter, retrying
non-retryable errors, and removing the poison-pill guard were each caught.

**Smoke-tested on the real server with 3 worker processes**: fan-out of six 1-second tasks finished in ~1.2 s
wall-clock, 2 tasks per worker (local sanity check, not a benchmark); a flaky task completed on attempt 3; same
Idempotency-Key twice gave the same execution and `Idempotent-Replayed: true`, and a different body gave 422;
SIGTERM to a busy worker let its task finish before it exited.

**Not built** (do not claim): distributed locks, pause/resume/cancel endpoints, heartbeats and a worker registry,
Kafka, scheduled workflows, and the whole AI layer (Phases 11–23), plus Docker images for the app and Swagger.

## Phases 9–10 — Distributed lock, heartbeats, worker registry, pause/resume/cancel ✅

**Implemented**: `src/queues/lock.js` (SET NX PX + random token, compare-and-delete release, compare-and-extend,
INCR fencing counter). Short running lease `LEASE_TTL_MS` renewed every TTL/3 by the worker (`renewTaskLease`, fenced by
leaseToken); losing it aborts the handler. Worker registry (`Worker` model + Redis TTL key) and `GET /workers` (admin).
Engine `pauseExecution` / `resumeExecution` / `cancelExecution` with `POST /executions/:id/pause|resume|cancel`
(409 `INVALID_STATE` from the wrong state). Cancel marks RUNNING tasks CANCELLED too, and workers notice at their next
renewal (cooperative cancel).
**Tests**: 241 total, including lock races and stale-holder tests, heartbeat keeping a slow task, takeover making renewal
fail, pause/resume semantics, cancel vs completion race (5 rounds), and HTTP cancel/pause/resume/authorization.
**Mutation check**: lock release without the token check, and cancel skipping RUNNING tasks, were both caught.
**Not built**: Redlock or multi-node locking (single Redis, by design); the lock is used by the scheduler (Phase 12).

## Phase 11 — Kafka lifecycle events (transactional outbox) ✅
**Implemented**: `OutboxEvent` written in the same transaction as every state change (11 event types);
`src/events/relay.js` (publish, then mark; leader-elected with the Redis lock and run inside workers);
`src/events/kafka.js` (kafkajs, idempotent producer, explicit 3-partition topic, key = executionId);
`src/consumers/analytics.js` + `analyticsProcessor` (idempotent: dedupe row and effect in one transaction);
Kafka (KRaft, host port 9095) in docker compose.
**Tests**: 252 total. New: event sequence, rollback leaves no event, duplicate report emits no event, pause/resume/cancel
events, relay marking and Kafka-down behaviour, relay leader election, idempotent consumer (duplicate + 5-way race), and a
**real Kafka round trip** with a forced duplicate publish (8 messages → 4 applied, 4 skipped).
**Honest limits**: at-least-once, not exactly-once; `task.started` is not transactional; single Kafka broker.

## Phase 12 — Scheduled workflows (cron) ✅
**Implemented**: `PUT/DELETE /workflows/:id/schedule` (5-field cron, IANA timezone, schedule input; 6-field, per-second
crons are rejected). `src/scheduler/scheduler.js` runs inside workers, leader-elected with the Redis lock. Each slot uses an
idempotency key `schedule:<workflowId>:<slot>`. The order is start the run, then advance `nextRunAt` with CAS. There's no
backfill of missed slots. Executions record `trigger: manual | schedule`.
**Tests**: 264 total, including timezone maths, invalid cron and timezone, a due run starting once, no backfill after an
outage, a crash between start and advance deduplicated, two concurrent schedulers → 1 run, **three lock-less "leaders" → still
1 run** (idempotency is the real guarantee), a broken graph not blocking the schedule, and the API with auth.
**Bug found by tests**: an unknown timezone ("Mars/Olympus") was accepted, because cron-parser doesn't validate it at parse
time. It's now validated with `Intl.DateTimeFormat`.

## Phases 13–14 — LLM provider abstraction + structured output ✅
**Implemented**: the provider interface (`chat`, `embed`); an OpenAI-compatible provider over `fetch` (Ollama locally) with
normalised, retryable-aware `ProviderError` and timeouts; a deterministic mock provider (bag-of-words embeddings);
`generateStructured` (JSON Schema from zod in the prompt, JSON mode, zod validation, repair turns, `StructuredOutputError`);
prompt-injection delimiters; LLM config (`LLM_*`, `EMBEDDING_MODEL`); an opt-in real-model suite `npm run test:llm`.
**Tests**: unit tests for validation and repair (malformed JSON, schema violation, exhaustion, stripped keys), provider HTTP
mapping, error classification, timeout and key hygiene. The real Ollama suite passes (structured output, and embeddings where
related texts are closer).

## Phases 15–16 — AI classification + model routing ✅
**Implemented**: `classifyTask` (structured and validated, prompt-versioned, with a heuristic fallback marked `source`);
`routeTask` (4 deterministic rules); `ai.classify`, `ai.route` and `ai.generate` handlers wired into workers, with the LLM
provider coming from config.
**Tests**: 290 total. The router rule table, the classifier (injection delimiter, unreachable → heuristic, garbage →
heuristic after repairs), and e2e runs classify→route→generate (the small vs large model actually answers, no double
classification, a RAG route refused by generate, an LLM timeout retried and succeeding). Real model: classification plus routing.
**Finding**: the small model missed a RAG case with v1; few-shot v2 fixed it for that query (3/3 runs). This isn't an evaluation.

## Phases 17–19 — RAG ingestion, Qdrant retrieval, LangChain.js ✅
**Implemented**: `KnowledgeDocument` and `KnowledgeChunk` models; clean → hash-dedupe → chunk (LangChain splitter) → embed →
MongoDB + Qdrant, with failure cleanup; a Qdrant vector store (one collection per model and dimension, ownerId payload index
and filter, Query API); `rag.answer` (top-K + threshold, numbered delimited context, citations validated as an enum of
retrieved ids, refusal without evidence); the `ai.rag` handler (scoped to the run owner); `POST/GET/DELETE /documents` and
`POST /knowledge/search`; Qdrant in compose and in `/ready`.
**Tests**: 310 total (plus real-model RAG in `test:llm`).
**Bugs found**: the Qdrant client 1.19 removed `search` (moved to `query`); `cleanText` didn't collapse tabs; RAG prompt v1
made the small model return `grounded:false` for cited answers (fixed with v2 positive-first).
**Honest limitation**: qwen2.5:0.5b is unreliable at citing sources for multi-paragraph chunks, so the system refuses rather
than answer uncited. See docs/rag.md.

## Phase 20 — Controlled AI agent + tools ✅
**Implemented**: `runAgent` (structured steps, tool enum allowlist, arg validation, per-tool timeouts, truncation, max iterations,
loop guard, overall timeout and abort); read-only tools (knowledge search, workflow status, safe calculator) scoped by the task's
ownerId; `selectTools` (allowlist ∩ registry ∩ role); the `ai.agent` handler (no answer → non-retryable failure).
**Tests**: 341 total. **Real model**: correct tool call, then a repeated call, stopped by the loop guard (3/3). The model is too small
to finish; see docs/agents.md.

## Phase 21 — Human-in-the-loop ✅
**Implemented**: the `human.approval` handler (returns `AwaitApproval`); `engine.suspendForApproval` (transactional park, worker
freed); `engine.resolveApproval` (CAS decision + task transition + shared success/fail helpers, in one transaction); the reconciler
expires overdue approvals; cancel closes pending approvals; `GET /approvals`, `GET /approvals/:id`,
`POST /approvals/:id/approve|reject`. The engine was refactored so approvals reuse `afterTaskSucceeded` / `afterTaskFailedForGood`.
**Tests**: 348 total. The e2e covers park (no worker held), approve → resume → complete, reject → fail-fast, a 6-way approve/reject race
→ one winner, timeout → expired, cancel while waiting, and authorization. **Mutation**: removing the PENDING CAS was caught by the race test.

## Phases 22–23 — AI fallback + circuit breaker; LLM observability + analytics ✅
**Implemented**: `createCircuitBreaker`, `createFallbackProvider` (retryable-only fallback, model mapping, no embedding fallback),
`createObservedProvider` + AsyncLocalStorage task attribution, the `AIExecution` model, cost from `LLM_PRICING_JSON`, an optional
secondary provider via `LLM_FALLBACK_*`, and `GET /analytics/ai` and `GET /analytics/workflows` (p95 via `$percentile`).
**Tests**: 363 total (breaker transitions, fallback rules, cost maths, config validation, attribution + analytics e2e with scoping).
Real-model fallback demo with circuit opening.

## Phase 24 — Security hardening ✅
**Implemented**: Redis sliding-window rate limiting (atomic Lua; login per IP+email and per IP, register, API per user,
runs, uploads; auth fails closed, the rest fails open; RateLimit/Retry-After headers); `TRUST_PROXY`; a per-route body limit
(`/documents` 256 KB, the rest 100 KB). **Bug fixed**: document uploads over 100 KB were refused by the global body parser
despite a 200 KB schema limit. Added `npm run check:secrets` and `npm run audit`, and wrote the threat model table in
docs/security.md.
**Tests**: 373 total, including the limiter race (20 → exactly 5), sliding recovery, brute force + spraying, fail-closed vs
fail-open, NoSQL injection, body limits, and prompt injection with an *obedient* model.
