# Architecture

This document has two clearly separated parts:

1. **Implemented** — what the code does today.
2. **Target design** — the planned architecture. Nothing in part 2 should be
   read as existing until [docs/progress.md](docs/progress.md) marks it done.

---

## 1. Implemented (Phases 1–6)

```
            ┌────────────────────────────── API process (src/server.js) ─┐
 HTTP ───►  │ requestId → pino-http → helmet → express.json(limit)       │
            │   → /health (liveness, no deps)                             │
            │   → /ready  (readiness) ──► runHealthChecks (parallel,      │
            │                              per-check timeout)             │
            │   → /auth/*, /users/:id/role                                │
            │       authenticate(JWT) → requirePermission(RBAC)           │
            │       → validate(zod) → controller → authService            │
            │   → /workflows[/:id]                                        │
            │       authenticate → requirePermission → validate           │
            │       → workflowService (validateDag, ownerScope, version CAS)│
            │   → /workflows/:id/run, /executions/:id → executionService  │
            │       → ENGINE (transactions, CAS, pendingTasks counter)    │
            │            │ enqueue(taskId)          ▲ start/complete/fail │
            │            ▼                          │                     │
            │   REDIS QUEUE ──claim (Lua: pop+lease)──► QUEUE WORKER      │
            │   ready / leases / delayed / members      (N loops, ack last)│
            │                                           → handlers        │
            │   reconciler (interval): MongoDB truth → re-enqueue         │
            │   → notFound → errorHandler (uniform JSON errors)           │
            └───────────────┬─────────────────────────┬───────────────────┘
                            ▼                         ▼
                 MongoDB 7 (replica set rs0)      Redis 7 (AOF, noeviction)
```

**Key design points**

- **Composition root.** `server.js` is the only file that reads config and
  opens connections. `createApp()` receives everything it needs as arguments,
  so tests build the app with fake dependencies and no infrastructure.
- **Fail fast at boot.** Invalid config or an unreachable Mongo/Redis at
  startup exits the process with code 1. A process supervisor (Docker,
  Kubernetes) is responsible for restarting.
- **Liveness ≠ readiness.** `/health` never checks dependencies (avoids restart
  storms during a DB outage); `/ready` does, and also returns 503 while the
  process is shutting down so a load balancer drains it first.
- **Fail fast at runtime too.** The Redis client has its offline queue
  disabled: while Redis is down, commands error immediately instead of
  queueing in memory.
- **Mongo as a replica set** (even single-node) so multi-document
  transactions are available when the outbox pattern arrives.
- **Redis `noeviction`** so a full Redis rejects writes rather than silently
  deleting queue data.
- **Auth is stateless on the hot path.** Access JWTs are verified by signature
  only (no DB hit per request). Revocation happens at refresh time through
  `user.tokenVersion`. Details and trade-offs are in [docs/security.md](docs/security.md).
- **Authorization is split in two.** RBAC (the permission table) answers "may this
  role do this action?". Ownership checks answer "is this object yours?" and
  live in the query itself (`ownerScope`), so a foreign resource is a 404.
- **Explicit state machines + compare-and-set.** Every task status change is
  checked against a transition table *and* applied with a conditional update
  (`{ status: from }`), so racing actors can't both win. See
  [docs/workflow-engine.md](docs/workflow-engine.md).
- **Definitions vs executions.** Workflows are versioned definitions. A run copies
  each task's type and config into its own Task documents (the snapshot).
- **No central orchestrator.** Whoever finishes a task runs the engine's
  completion transaction, which releases the children. All state is in MongoDB,
  so a crashed process loses nothing that recovery can't rebuild. Details, including
  every race and its fix, are in [docs/workflow-engine.md](docs/workflow-engine.md).
- **Redis is coordination, MongoDB is truth.** Redis holds only task ids (ready list,
  leases, delayed set). Every multi-step queue move is one Lua script, so a task id
  can never be "popped and lost". If Redis and MongoDB disagree, the reconciler makes
  Redis match MongoDB. See [docs/redis.md](docs/redis.md).
- **Leases + fencing for crash recovery.** A claimed task carries a lease
  (`timeoutMs + grace`, on the database's clock). If it expires, another worker takes
  over with a new `leaseToken`, and the dead worker's late report is rejected.
- **Temporary:** the queue worker runs inside the API process. Phase 7 moves it to
  its own process without changing the engine or the queue. Data model details are in
  [docs/database-design.md](docs/database-design.md).

## 2. Target design (not implemented yet)

Responsibilities each technology WILL have — each has exactly one job:

| Component | Responsibility |
|---|---|
| MongoDB | Durable source of truth for workflows, executions, tasks, approvals, AI calls |
| Redis | Fast coordination: ready queue, leases, delayed jobs, locks, rate limits, heartbeats (rebuildable from Mongo) |
| Kafka | Stream of lifecycle events for analytics/audit consumers (at-least-once) — not a task queue |
| Workflow engine | Dependency resolution: decide which tasks are ready |
| Workers | Execute task handlers under a lease, separate processes |
| AI layer | Provider abstraction (Ollama via OpenAI-compatible API + mock), routing, RAG (Qdrant), bounded agent |

The phase plan and progress live in [docs/progress.md](docs/progress.md);
design decisions in [docs/decisions.md](docs/decisions.md).
