# Database Design (MongoDB)

Only collections that exist in code are listed. Each one records its fields, indexes, the queries those indexes serve, and consistency notes.

MongoDB runs as a replica set (see ADR-002), so multi-document transactions are available.

## Why MongoDB fits
- **Workflow definitions are naturally documents.** A workflow and its task list are read and written together, and task `config` differs per task type, which suits a flexible schema.
- **Atomic single-document conditional updates** (`updateOne({ _id, status: X }, …)`) are the main correctness tool. They're used for state transitions, optimistic concurrency and fencing.
- **Where it's weaker:** no foreign keys and no joins by default. Relationships (`ownerId`, `executionId`) are enforced by application code. Cross-document atomicity needs transactions.

---

## users
| Field | Type | Notes |
|---|---|---|
| email | string | lower-cased, trimmed, **unique** |
| passwordHash | string | bcrypt, `select: false` |
| role | enum admin/operator/viewer | default `viewer` |
| tokenVersion | number | refresh-token revocation counter |

**Indexes:** `{ email: 1 }` unique. Used for login lookups and to guarantee one account per email under concurrency.

## workflows (definitions, the "recipes")
| Field | Type | Notes |
|---|---|---|
| ownerId | ObjectId → users | set from the JWT, never from the request body |
| name, description | string | |
| tasks[] | embedded `{ key, name, type, dependsOn[], config, retryPolicy{maxAttempts, baseDelayMs}, timeoutMs }` | the DAG definition, max 100 tasks |
| version | number | **optimistic concurrency**: every update must match it and bumps it |

**Indexes:** `{ ownerId: 1, createdAt: -1 }` serves "my workflows, newest first".

**Why task definitions are embedded:** they're always read and written together with the workflow, and they're bounded (≤ 100). One document means an edit is atomic without a transaction.

**Consistency:** an update is `findOneAndUpdate({ _id, ownerId?, version: N }, { $set…, $inc: { version: 1 } })`. Concurrent edits of the same version produce exactly one winner, and the others get 409 (covered by a test).

## workflowexecutions (one run)
| Field | Notes |
|---|---|
| workflowId, ownerId | ownerId is denormalised, so ownership checks need one query |
| workflowVersion | **snapshot**: which definition version this run uses |
| status | execution state machine (`src/workflow/states.js`) |
| input, triggeredBy, startedAt, completedAt, error | |
| taskCount | number of tasks in the run |
| idempotencyKey, requestHash | client key + SHA-256 of canonical `{workflowId, input}`; `requestHash` is never returned by the API |
| **pendingTasks** | tasks not yet finished (COMPLETED/FAILED/CANCELLED). Decremented with `$inc` in the same transaction that finishes a task. This is the write-skew fix: every completion writes this one document, so concurrent "last task" completions conflict and serialise |

**Indexes:** `{ workflowId, createdAt: -1 }`, `{ ownerId, createdAt: -1 }`, `{ status }`, and
`{ triggeredBy, idempotencyKey }` **unique, partial** (only documents that have a key). This gives idempotent run
creation in the same insert as the run itself, so no separate IdempotencyRecord collection is needed.

## tasks (one task instance per execution)
| Field | Notes |
|---|---|
| executionId, ownerId, key, type, config | |
| dependsOn[], dependents[], remainingDeps | dependency bookkeeping for the engine |
| status | task state machine |
| attempt, maxAttempts, baseDelayMs, timeoutMs | retry bookkeeping |
| leaseOwner, **leaseToken**, leaseExpiresAt | lease + **fencing token** (incremented per claim, prevents ABA) |
| output, error, readyAt, retryAt, queuedAt, startedAt, completedAt | `readyAt` / `retryAt` let the reconciler find stranded READY tasks and lost retry wake-ups |

**Indexes:**
- `{ executionId, key }` unique: one task per key per run. It also makes task creation safe to retry.
- `{ executionId, status }` serves "tasks of this run in state X".
- `{ status, leaseExpiresAt }` serves the recovery sweeper's "RUNNING with an expired lease" query (Phase 10).
- `{ status, readyAt }` serves the reconciler's "READY for longer than N seconds" query.
- `{ status, retryAt }` serves the reconciler's "RETRYING and overdue" query.

**`minimize: false`:** Mongoose drops empty objects on save by default, which silently changed handler outputs (`{ config: {} }` was stored as `{}`). Task config and output are user data and must round-trip exactly.

**Why separate documents instead of an array inside the execution:** two workers completing sibling tasks update *different* documents, so there's no contention on one hot document. The sweeper can index-scan tasks across all executions, and there's no risk of the 16MB document limit. The cost is that multi-task changes need a transaction.

**Consistency:** every single-task status change goes through `transitionTask(id, from, to)` or `claimQueuedTask`, which is `updateOne({ _id, status: from, …where }, …)`. It returns `false` if another actor changed the task first. Tests cover 10 concurrent completions (exactly one wins), complete-vs-cancel (one outcome sticks), and a stale fencing token being rejected.

## taskexecutions (one attempt of a task)
| Field | Notes |
|---|---|
| taskId, executionId, attempt, workerId, leaseToken | |
| status | RUNNING / SUCCEEDED / FAILED / TIMED_OUT / ABANDONED |
| startedAt, finishedAt, durationMs, error{message, retryable} | |

**Indexes:** `{ taskId, attempt }` unique (one record per attempt), and `{ executionId, createdAt }`.

This is an append-only attempt history. It replaces Project 1's growing embedded `history[]` array. One is created per claim and closed as SUCCEEDED, FAILED or TIMED_OUT.

## Not yet created
Worker (registry; Phase 10), ApprovalRequest, AIExecution, Document, KnowledgeChunk and OutboxEvent. Each arrives in the phase that uses it.
