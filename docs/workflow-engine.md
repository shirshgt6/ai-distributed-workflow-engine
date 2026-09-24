# Workflow Engine

> **Implemented so far (Phase 3):** state machines, the conditional transition primitive, and the data model.
> **Not implemented yet:** DAG validation (Phase 4), execution and dependency resolution (Phase 5), queueing and workers (Phases 6–7).

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
