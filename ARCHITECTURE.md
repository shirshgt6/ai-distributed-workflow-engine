# Architecture

This document has two clearly separated parts:

1. **Implemented** — what the code does today.
2. **Target design** — the planned architecture. Nothing in part 2 should be
   read as existing until [docs/progress.md](docs/progress.md) marks it done.

---

## 1. Implemented (Phases 1–2)

```
            ┌────────────────────────────── API process (src/server.js) ─┐
 HTTP ───►  │ requestId → pino-http → helmet → express.json(limit)       │
            │   → /health (liveness, no deps)                             │
            │   → /ready  (readiness) ──► runHealthChecks (parallel,      │
            │                              per-check timeout)             │
            │   → /auth/*, /users/:id/role                                │
            │       authenticate(JWT) → requirePermission(RBAC)           │
            │       → validate(zod) → controller → authService            │
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
  are added with the first owned resource (workflows, Phase 3).

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
