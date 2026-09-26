# Human-in-the-loop (Phase 21)

## Flow
```
... → recommend (e.g. AI suggests a ₹50,000 refund)
    → approve   type "human.approval"  config { title, message?, timeoutMs? (default 24h, max 7d) }
         handler returns AwaitApproval → worker calls engine.suspendForApproval:
         [TRANSACTION] task RUNNING → WAITING_FOR_APPROVAL (fenced) + ApprovalRequest{PENDING, context = parents' outputs, expiresAt}
         the worker is FREE; the wait is just rows in MongoDB (survives restarts, costs nothing)
    → POST /approvals/:id/approve | reject {comment?}      (permission approval:decide + run ownership)
         [TRANSACTION] ApprovalRequest PENDING → APPROVED|REJECTED   (compare-and-set)
                       task WAITING → COMPLETED (output {approved, decidedBy, comment}) → normal success path
                                  or → FAILED (non-retryable)                          → normal fail-fast path
    → payout (runs only after approval; receives the decision as a parent output)
```
- **Timeout:** the reconciler expires PENDING approvals past `expiresAt` → `EXPIRED` → the task fails with "Approval timed out".
- **Cancel:** cancelling the run marks its PENDING approvals `CANCELLED`, and deciding afterwards returns 409.
- **Pause:** an approval decided while the run is paused is recorded, and the next task starts on resume.

## Why it's safe
| Concern | Mechanism |
|---|---|
| Two approvers click at once, or a click races the timeout | CAS `status: PENDING` on the ApprovalRequest: one winner, the others get **409 ALREADY_DECIDED** (tested 3 approve + 3 reject concurrently) |
| Decision recorded for a task that's no longer waiting (run cancelled) | the task CAS `WAITING_FOR_APPROVAL → …` fails, so the **whole transaction aborts** and nothing is recorded |
| Approve twice | the second attempt is 409 (the decision is final; there's no silent re-apply) |
| Someone else's approval | ownership in the query → 404; a viewer → 403 |
| Lost decisions / double effects | decision + task transition + children promotion + outbox event are one transaction |

Approval and rejection reuse the same `afterTaskSucceeded` / `afterTaskFailedForGood` helpers as normal task
completion, so pendingTasks, children and fail-fast behave identically (refactor verified by the existing engine tests).

## Not implemented
Separation of duties (the run owner can approve their own run), multi-step or quorum approvals, notifications (email/Slack),
and approver roles other than "run owner or admin". The execution stays `RUNNING` while a task waits: the execution-level
`WAITING_FOR_APPROVAL` status exists in the state machine but isn't set.
