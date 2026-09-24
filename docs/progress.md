# Progress

Only phases marked ✅ are implemented. Everything else is planned.

| # | Phase | Status |
|---|---|---|
| 1 | Project architecture + configuration | ✅ |
| 2 | Authentication + RBAC | ✅ |
| 3 | Workflow and task domain models | ✅ |
| 4 | DAG validation | ✅ |
| 5 | Workflow execution engine | ⬜ |
| 6 | Redis task scheduling | ⬜ |
| 7 | Distributed workers | ⬜ |
| 8 | Concurrency + retries + backoff | ⬜ |
| 9 | Idempotency + distributed locks | ⬜ |
| 10 | Worker heartbeat + crash recovery | ⬜ |
| 11 | Kafka event architecture (transactional outbox) | ⬜ |
| 12 | Scheduled workflows | ⬜ |
| 13 | LLM provider abstraction | ⬜ |
| 14 | Structured output + validation | ⬜ |
| 15 | AI task classification | ⬜ |
| 16 | AI model routing | ⬜ |
| 17 | RAG ingestion pipeline | ⬜ |
| 18 | Qdrant retrieval | ⬜ |
| 19 | LangChain.js integration | ⬜ |
| 20 | Controlled AI agents + tools | ⬜ |
| 21 | Human-in-the-loop | ⬜ |
| 22 | AI retry/fallback | ⬜ |
| 23 | LLM observability + analytics | ⬜ |
| 24 | Security hardening | ⬜ |
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
