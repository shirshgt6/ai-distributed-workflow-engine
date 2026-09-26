# Architecture

Everything described here is implemented and tested. Per-area detail lives in [docs/](docs/). What is **not** built
is listed at the end.

## System view
```
                    ┌──────────────────────────── API (src/server.js) ─────────────────────────────┐
 HTTP / JWT ──────► │ requestId → logs → helmet → body limits → rate limits → auth → RBAC → zod    │
                    │ /auth /workflows(+schedule) /executions /approvals /documents /knowledge      │
                    │ /analytics /workers /docs                                                     │
                    │ ENGINE.startExecution: [Mongo txn] run + tasks + outbox event → enqueue       │
                    └───────────────┬───────────────────────────────────────┬──────────────────────┘
                                    ▼ enqueue(taskId)                        │ reads/writes
            ┌────────── Redis ──────────────────────┐        ┌───────────── MongoDB (replica set) ─────────────┐
            │ ready LIST · leases ZSET · delayed    │        │ SOURCE OF TRUTH: workflows, executions, tasks,  │
            │ ZSET · members SET (Lua, atomic)      │        │ attempts, approvals, outbox, AI calls, docs,    │
            │ locks (scheduler, relay) · heartbeats │        │ chunks, users, workers, event stats             │
            │ rate-limit windows                    │        └──────────────────────────────────────────────────┘
            └───────────────┬───────────────────────┘                 ▲
                            ▼ claim (pop + lease)                      │ transactions, CAS, fencing
       ┌──────────── WORKER processes × N (src/worker.js) ─────────────┴────────────────────────┐
       │ claim loops → engine.startTask (lease, takeover) → handler (timeout, AbortSignal,         │
       │ heartbeat renewal) → completeTask / failTask (retry·DLQ) / suspendForApproval → ack       │
       │ + reaper/promoter · reconciler · scheduler (leader) · outbox relay (leader)                │
       │ handlers: noop delay fail flaky echo human.approval ai.classify ai.route ai.generate       │
       │           ai.rag ai.agent                                                                   │
       └───────┬──────────────────────────────┬──────────────────────────────┬─────────────────────┘
               ▼ provider interface            ▼ vectors                      ▼ outbox relay
   observed(fallback([Ollama | any           Qdrant (collection per       Kafka "workflow-events"
   OpenAI-compatible], breakers))            embedding model; ownerId      → analytics consumer
   → AIExecution rows                        filter in every query)          (idempotent)
```

## Responsibilities (each technology has one job)
| Component | Job | Why this and not something else |
|---|---|---|
| **MongoDB** | Durable state; the single source of truth | document-shaped workflows, atomic conditional updates, multi-document transactions (replica set) |
| **Redis** | Coordination: which task next, leases, delayed retries, locks, heartbeats, rate limits | in-memory atomic ops + Lua. Rebuildable from MongoDB by the reconciler |
| **Kafka** | Lifecycle *events* for independent consumers | replayable log, consumer groups, per-key ordering. **Not** the task queue (no ack/visibility timeout/delay) |
| **Qdrant** | Vector similarity search for RAG | purpose-built ANN index + payload filters for tenant isolation |
| **Engine** | Dependency resolution and state transitions | a set of functions, not a process, so there's no orchestrator single point of failure |
| **Workers** | Execute handlers | stateless processes, scaled horizontally |
| **AI layer** | Provider abstraction, validation, routing, RAG, agent, fallback, observability | business code depends on an interface, never a vendor |

## Correctness mechanisms (where the interview depth is)
- **Transactions** for every multi-document state change: start a run, complete or fail a task, approvals, pause/resume/cancel,
  and outbox rows.
- **Compare-and-set** (`{ status: expected }` in the filter) for every single-document transition, so racing actors have exactly one winner.
- **Fencing tokens** (`leaseToken`) so a stale worker's late report is rejected.
- **Leases + heartbeats**: a dead worker's task is taken over after ≤ `LEASE_TTL_MS`.
- **Atomic Redis scripts**: claim = pop + lease, so a task id is never lost; plus reaper, dedupe, rate limits and locks.
- **Write-skew prevention**: the `pendingTasks` counter on the execution makes concurrent final completions conflict.
- **Idempotency**: runs (key on the execution under a unique index), scheduled slots, consumers (processed-event table), enqueue (members set).
- **Transactional outbox**: an event is written with its state change. At-least-once delivery, deduplicated consumers.
- **Reconciler**: MongoDB is the truth; READY/QUEUED/RUNNING/RETRYING stragglers and expired approvals are repaired.

Verified by race tests, mutation checks, crash-simulation tests and a chaos test (see [docs/testing.md](docs/testing.md)).

## Where to read more
| Topic | Doc |
|---|---|
| Engine, states, DAG, races | [docs/workflow-engine.md](docs/workflow-engine.md) |
| Queue, leases, locks | [docs/redis.md](docs/redis.md) |
| Events | [docs/kafka.md](docs/kafka.md) |
| AI layer | [docs/ai-architecture.md](docs/ai-architecture.md), [docs/rag.md](docs/rag.md), [docs/agents.md](docs/agents.md) |
| Human approval | [docs/human-in-the-loop.md](docs/human-in-the-loop.md) |
| Security | [docs/security.md](docs/security.md) |
| Observability | [docs/observability.md](docs/observability.md) |
| Data model | [docs/database-design.md](docs/database-design.md) |
| API | [docs/api-design.md](docs/api-design.md) · live at `/docs` |
| Decisions | [docs/decisions.md](docs/decisions.md) |
| Interview prep | [docs/interview-guide.md](docs/interview-guide.md) · [docs/phase-summaries.md](docs/phase-summaries.md) |

## Not built (by design or out of scope)
- **High availability:** single-node MongoDB, Redis, Kafka and Qdrant locally. Production needs replicas.
- **OpenTelemetry tracing and Prometheus metrics:** correlation ids plus MongoDB analytics instead.
- **Exactly-once end-to-end processing:** at-least-once delivery with state changes applied once.
- **PDF/DOCX extraction, re-ranking, hybrid search, RAG evaluation sets.**
- **Refresh-token rotation, separation of duties for approvals, CORS configuration.**
- **Useful answers from the 0.5B local model** for citations and agents: the controls work, but a larger model is needed.
