# Workflow Engine

> **Implemented so far (Phases 3–5):** state machines, the conditional transition primitive, the data model, DAG validation, and **execution** (dependency resolution, fail-fast, reconciliation) with an **in-process executor**.
> **Not implemented yet:** a Redis queue (Phase 6), separate worker processes (Phase 7), retries (Phase 8), pause/resume/cancel, and lease-based crash recovery (Phase 10).

## Definition vs execution

| Concept | Model | Analogy |
|---|---|---|
| Workflow definition | `Workflow` (tasks embedded, `version`) | the recipe card |
| One run | `WorkflowExecution` (`workflowVersion` snapshot) | cooking the recipe today |
| One step in one run | `Task` | "dal is on the stove right now" |
| One attempt of a step | `TaskExecution` | "second try at the dal" |

Editing a workflow bumps its `version`. A running execution keeps the version it started with (snapshot), so edits never change a run in progress.

## State machines (`src/workflow/states.js`)

### Task
```
PENDING → READY → QUEUED → RUNNING → COMPLETED
                    ↑  │      │
                    │  └→READY (queue item lost, reconciler)
                    │         ├→ RETRYING → QUEUED           (retry after backoff)
                    └─────────├→ QUEUED                      (worker died, lease expired)
                              ├→ FAILED → DEAD_LETTER
                              ├→ WAITING_FOR_APPROVAL → COMPLETED | FAILED
any non-terminal state ──────────────→ CANCELLED
```
- **Terminal:** COMPLETED, DEAD_LETTER, CANCELLED, which have no outgoing transitions.
- FAILED can only move to DEAD_LETTER.

### Execution
```
PENDING → RUNNING → COMPLETED | FAILED
            ⇅ PAUSED
            ⇅ WAITING_FOR_APPROVAL (→ FAILED on reject/timeout)
PENDING | RUNNING | PAUSED | WAITING_FOR_APPROVAL → CANCELLED
```
- **Terminal:** COMPLETED, FAILED, CANCELLED.

## Two layers of protection

1. **Transition table (logic).** `assertTransition(machine, from, to)` throws `InvalidTransitionError` for a transition that is never legal, such as COMPLETED → READY. This catches coding mistakes.
2. **Conditional update (concurrency).** `transitionTask(id, from, to)` runs `updateOne({ _id, status: from }, { $set: { status: to } })`. If someone else moved the task first, nothing matches and it returns `false`. The caller then knows it lost the race and must not act (no enqueue, no notifying dependents). This is compare-and-set.

Extra conditions can be added. For **fencing**, use `where: { leaseOwner, leaseToken }`. A worker whose lease was taken over has an older `leaseToken`, so its late write is rejected even if its worker name matches. That's the ABA case that a name-only lock check (Project 1's `lockedBy`) misses.

The table alone can't stop two workers racing, and the conditional update alone can't stop a logic bug. Both are needed.

## DAG validation (`src/workflow/dag.js`), Phase 4

Every workflow write (create and update) runs `validateDag(tasks)`. An invalid graph is rejected with
400 `INVALID_WORKFLOW_GRAPH`, so it can never be stored or executed. `POST /workflows/validate` runs the
same analysis without saving.

### Rejected graphs
| Code | Example | Why it must be rejected |
|---|---|---|
| `DUPLICATE_KEY` | two tasks keyed `A` | `dependsOn: ["A"]` is ambiguous; the `{executionId, key}` unique index would break |
| `SELF_DEPENDENCY` | A depends on A | the smallest cycle |
| `UNKNOWN_DEPENDENCY` | B depends on `ghost` | B would wait forever |
| `DUPLICATE_DEPENDENCY` | D depends on `[B, B]` | `remainingDeps` would be 2 for a parent that completes once, so D waits forever |
| `CYCLE` | A → B → C → A | every task in the loop waits for another |

All errors are collected and returned together.

### Algorithms
**Kahn's algorithm (BFS on in-degrees).** This is the engine's `remainingDeps` counter, simulated without running anything:
1. in-degree(task) = number of dependencies
2. every task with in-degree 0 forms the first *wave*
3. "complete" the wave: decrement each child's in-degree, and children that reach 0 form the next wave
4. if some tasks were never emitted, they are cycle members or blocked behind a cycle

Outputs:
- **`order`:** a topological order, where every task comes after all its dependencies.
- **`levels`:** tasks grouped into waves. Tasks in the same wave can run **in parallel**.
- **`levels.length`:** the **critical path** length counted in tasks, i.e. the minimum number of sequential steps even with unlimited workers.

**DFS with three colours.** Used only when Kahn reports a cycle, to name it (`A -> B -> C -> A`):
- WHITE = unvisited, GREY = on the current path, BLACK = fully explored.
- Reaching a GREY node again means we walked back into our own path, which is a cycle.
- Reaching a BLACK node is fine: two paths meeting (a diamond) is not a cycle.

Both algorithms are **O(V + E)**. Recursion depth in the DFS is bounded by the 100-task limit.

Example, the document pipeline from the project brief:
```
levels: [ingest] → [extract] → [classify, retrieve] → [analyse] → [approve] → [notify]
criticalPathLength: 6   (classify and retrieve can run in parallel)
```

"Critical path" here counts tasks, not time. The time-weighted critical path (using real durations) needs measured task latencies and isn't computed yet.

## Execution (`src/workflow/engine.js`), Phase 5

There's no central orchestrator process. The engine is a set of functions, and all state lives in MongoDB.
Whoever finishes a task runs `completeTask()`, which works out what became ready.

```
POST /workflows/:id/run
  └─ startExecution   [TRANSACTION] create execution (RUNNING, pendingTasks = n) + n Task docs
                      roots -> READY, others -> PENDING (remainingDeps = #dependencies)
  └─ dispatchReady    READY -> QUEUED (CAS) -> enqueue(task)          (after commit)
executor
  └─ startTask        QUEUED -> RUNNING (CAS), attempt+1, leaseToken+1, TaskExecution record
  └─ handler({ config, input, parents, signal })   with timeout
  └─ completeTask     [TRANSACTION]
        RUNNING -> COMPLETED   only if still RUNNING with this leaseToken  (duplicate/stale = no-op)
        execution.pendingTasks -= 1
        children.remainingDeps -= 1; PENDING & remainingDeps 0 -> READY   (only while execution RUNNING)
        pendingTasks == 0 -> execution COMPLETED
     └─ dispatchReady (after commit)
  └─ failTask         [TRANSACTION]  fail-fast (see below)
```

### Races and how each is handled
| Scenario | What would go wrong | Mechanism | Test |
|---|---|---|---|
| Crash while creating a run | execution without all its tasks (zombie) | one transaction for execution + tasks | rollback test |
| B and C complete at once (diamond) | D decremented wrongly, promoted or dispatched twice | both txns write D and the execution doc, MongoDB write conflict, automatic retry | 5 rounds, D dispatched exactly once |
| X and Y are both last tasks and finish at once | **write skew**: each snapshot sees the other RUNNING, so nobody completes the execution | `pendingTasks` counter on the execution doc, so both txns write the same doc and conflict | 5 rounds, execution COMPLETED. The naive count-based version was shown to leave it RUNNING |
| Duplicate completion report | double decrement, child released early | RUNNING -> COMPLETED CAS inside the txn; the second call matches nothing | duplicate test |
| Late report from an old attempt | overwrites a newer attempt | `leaseToken` fencing | stale-token test |
| Normal dispatch and reconciler at once | task enqueued twice | READY -> QUEUED CAS | race test |

**Trade-off:** every task completion in one execution writes the same execution document, so completions
within one run are serialised by write conflicts and retries. That's fine for ≤ 100 tasks per run. At much
larger fan-out, the counter could be sharded or completion checked asynchronously.

### Failure policy: fail-fast
When a task fails (no retries until Phase 8):
- the task becomes FAILED
- all tasks not yet started (PENDING, READY, QUEUED) become CANCELLED
- the execution becomes FAILED immediately, with `error = 'Task "<key>" failed: <message>'`
- tasks already RUNNING are allowed to finish. Their results are recorded, but nothing new is promoted.

Timeouts (`withTimeout` plus an `AbortSignal` passed to the handler) are failures recorded as `TIMED_OUT` attempts.

### Recovery
- **Stuck READY** (commit succeeded, process died before dispatch): `reconcileStuckReady` runs every `RECONCILE_INTERVAL_MS` and dispatches READY tasks older than `RECONCILE_STALE_MS`.
- **Process restart (single-process mode only):** the in-process queue is in memory, so on boot `recoverInProcessOrphans` moves RUNNING tasks to QUEUED (bumping `leaseToken` to fence the dead attempt), then QUEUED to READY, and dispatches them again. This is **only correct while exactly one process executes tasks**. Phase 10 replaces it with lease expiry.
- **Smoke-tested:** a run was killed with `kill -9` while B and C were RUNNING. After restart, both re-ran as attempt 2, D ran, and the execution completed.

### Data flow
Handlers receive `{ config, input, parents, signal }`, where `parents` is `{ parentKey: parentOutput }` and `input`
is the run's input. The output is stored on the task. Task documents use `minimize: false` so outputs round-trip
exactly (Mongoose would otherwise drop empty objects).

Built-in handlers (for exercising the engine): `noop`, `delay` (`config.ms` ≤ 60s, abortable), `fail`, `echo`.
