# Workflow Engine

> **Implemented so far (Phases 3–4):** state machines, the conditional transition primitive, the data model, and DAG validation.
> **Not implemented yet:** execution and dependency resolution (Phase 5), queueing and workers (Phases 6–7).

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
