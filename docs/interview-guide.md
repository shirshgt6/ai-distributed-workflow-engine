# Interview Guide: Distributed Workflow Orchestration Engine

Everything here describes code that exists in this repo and is covered by tests. Section 13 lists what must
**not** be claimed.

---

## 1. Pitches

### 30 seconds
> "I built a distributed workflow engine in Node.js. You define a workflow as a DAG of tasks. The engine validates
> the graph, runs independent tasks in parallel on horizontally scalable worker processes, and survives crashes.
> MongoDB is the source of truth for state, and Redis is a reliable task queue with leases. The interesting part is
> correctness under concurrency: every state change is a transaction or a compare-and-set, so duplicate deliveries,
> races between workers, and a worker being `kill -9`'d mid-task don't break a run."

### 1 minute
> "Users define workflows as DAGs, for example A, then B and C in parallel, then D. On save I validate the graph with
> Kahn's algorithm (cycles, unknown or duplicate dependencies) and name any cycle with a DFS. Running a workflow
> creates the execution and all its task documents in one MongoDB transaction. Root tasks go into a Redis queue.
> Workers are separate processes. They claim a task with a Lua script that pops the id *and* records a lease
> atomically, so a worker dying can never lose a task. When a task finishes, one transaction marks it complete,
> decrements its children's dependency counters and releases the ones that reach zero. There's no central
> orchestrator: whoever finishes a task advances the workflow. Failures are classified as transient or permanent.
> Transient ones retry with exponential backoff and jitter, then go to a dead-letter state. There's JWT auth with
> RBAC plus per-object ownership checks, and 225 automated tests including race and crash-recovery tests."

### 3 minutes
Use the 1-minute pitch, then walk through **one race** (sections 6.3 and 6.4) and **one crash** (section 6.6) in
detail. Those are where interviewers dig.

---

## 2. Architecture

```
Client ──HTTP/JWT──► API (Express)                          Worker processes × N (npm run worker)
                     auth · RBAC · ownership · validation     claim loops (concurrency per process)
                     workflows CRUD · DAG validation           engine.startTask → handler (timeout)
                     POST /run → engine.startExecution         → completeTask / failTask
                          │   (Mongo transaction)              → ack; reaper; promoter; reconciler
                          ▼ enqueue(taskId)                          ▲ claim (Lua: pop + lease)
                     ┌────────────── Redis ──────────────┐           │
                     │ ready LIST · leases ZSET ·        │───────────┘
                     │ delayed ZSET · members SET        │
                     └───────────────────────────────────┘
                     ┌────────────── MongoDB (replica set, source of truth) ──────────────┐
                     │ users · workflows · workflowexecutions · tasks · taskexecutions     │
                     └─────────────────────────────────────────────────────────────────────┘
```

| Component | Its ONE job | Why this tech |
|---|---|---|
| MongoDB | Durable truth: definitions, runs, task state, attempt history | Document model fits workflows. Atomic conditional updates. Multi-document transactions (replica set) |
| Redis | Coordination: which task id to pick next, leases, delayed retries | In-memory O(1)/O(log n) ops. Lua scripts are atomic. Everything in it can be rebuilt from MongoDB |
| Engine | Dependency resolution and state transitions | A set of functions, not a process, so it has no single point of failure |
| Workers | Run handlers | Stateless, so you scale by adding processes |

---

## 3. Request lifecycle: `POST /workflows/:id/run`
1. `requestId` middleware sets a correlation id, and pino-http logs the request with the `userId`
2. `authenticate`: verify the JWT signature, expiry and `type` (no DB hit) → `req.user` (else **401**)
3. `requirePermission("workflow:run")`: RBAC table (viewer → **403**)
4. `validate`: zod parses `params`/`body` into `req.valid` (unknown fields dropped) (else **400**)
5. Service: `Workflow.findOne({ _id, ...ownerScope(user) })`. A foreign workflow returns **404, not 403**, so its existence doesn't leak
6. Optional `Idempotency-Key` gets a SHA-256 of canonical `{workflowId, input}`
7. `engine.startExecution`: re-validate the DAG, then **one transaction** inserts the execution (RUNNING, `pendingTasks = n`, idempotency key) and n tasks (roots READY)
8. After commit: READY → QUEUED (CAS), then `enqueue(taskId)` to Redis. If Redis is down, it logs and moves on; the reconciler fixes it later
9. Respond **202 Accepted** + `Location: /executions/:id`. The client polls
10. A duplicate idempotency key hits the unique index: same request → 202 with the same run and `Idempotent-Replayed: true`; different request → **422**

## 4. Task lifecycle (inside a worker)
```
claim (Redis Lua: LPOP ready + ZADD leases now+30s)
 → startTask (Mongo pipeline update: QUEUED | RETRYING | RUNNING-with-expired-lease → RUNNING,
              attempt+1, leaseToken+1, leaseExpiresAt = $$NOW + timeoutMs + grace)
 → extend the Redis lease to timeoutMs + grace
 → handler({ config, input, parents, attempt, signal }) with a timeout (+ AbortSignal)
 → completeTask (txn: CAS COMPLETED by leaseToken; pendingTasks−1; children remainingDeps−1;
                 PENDING & 0 → READY; pendingTasks==0 → execution COMPLETED) → dispatch READY
   or failTask  (txn: RETRYING + enqueueDelayed(backoff) | FAILED | DEAD_LETTER + fail-fast)
 → ack (only after MongoDB has the result)
```

---

## 5. State machines
- **Task:** PENDING → READY → QUEUED → RUNNING → COMPLETED. RUNNING → RETRYING → QUEUED. RUNNING → FAILED → DEAD_LETTER. RUNNING → QUEUED (takeover). Any non-terminal state → CANCELLED.
- **Execution:** PENDING → RUNNING → COMPLETED | FAILED | CANCELLED (PAUSED and WAITING_FOR_APPROVAL exist in the table, but there are no endpoints for them).
- **Two layers:** a transition table (`assertTransition`) catches logic bugs like COMPLETED → READY. A conditional update `{ status: from }` catches races. You need both.

---

## 6. Deep dives (the questions interviewers actually ask)

### 6.1 DAG validation: Kahn's algorithm, O(V+E)
```js
function topoSort(tasks) {
  const inDegree = new Map(), children = new Map();
  for (const t of tasks) { inDegree.set(t.key, t.dependsOn.length); children.set(t.key, []); }
  for (const t of tasks) for (const d of t.dependsOn) children.get(d).push(t.key);
  const queue = tasks.filter(t => inDegree.get(t.key) === 0).map(t => t.key);
  const order = [];
  for (let head = 0; head < queue.length; head++) {       // index pointer: O(1) dequeue
    const k = queue[head]; order.push(k);
    for (const c of children.get(k)) {
      inDegree.set(c, inDegree.get(c) - 1);
      if (inDegree.get(c) === 0) queue.push(c);
    }
  }
  return order.length === tasks.length ? order : null;    // leftovers = cycle
}
```
- Processing wave by wave gives the **parallel levels**. `levels.length` is the critical path in tasks.
- **3-colour DFS** (WHITE/GREY/BLACK) names the cycle. Hitting GREY again means a cycle. Hitting BLACK is just two paths meeting (a diamond).
- Also rejected: self-dependency, unknown dependency, duplicate key, and **duplicate dependency** (`[B, B]` makes `remainingDeps = 2` for a parent that completes once, so the child waits forever).

### 6.2 Compare-and-set (CAS)
`updateOne({ _id, status: "RUNNING", leaseToken: 7 }, { $set: { status: "COMPLETED" } })`. `modifiedCount === 0`
means someone else changed it first: you lost the race, so don't act. Tested: 10 concurrent completions → exactly one wins.

### 6.3 Diamond race: B and C finish at the same moment
Both transactions decrement D's counter and the execution's `pendingTasks`. They write the same documents, so MongoDB
raises a **write conflict**, aborts one, and `connection.transaction()` retries it on fresh data. D is promoted and
dispatched **exactly once** (tested over 5 rounds).

### 6.4 Write skew: two LAST tasks finish together
The naive approach, "count unfinished tasks at the end of my transaction", fails. X's snapshot sees Y RUNNING, Y's
snapshot sees X RUNNING, and **neither completes the execution**, so it stays stuck RUNNING. **I reproduced this with a
mutation test.** The fix is a `pendingTasks` counter on the execution document. Every finishing transaction writes that
one document, which turns the skew into a detectable write conflict. The trade-off is that completions within one run
serialise on that document (fine at ≤ 100 tasks per run).

### 6.5 Reliable queue: Project 1's lost-job bug
In Project 1, `BZPOPMIN` popped the id, and if the worker died before recording the claim, the job was gone forever
(silent loss, and no scanner looked at QUEUED jobs). Now claiming is one **Lua script**: `LPOP ready` + `ZADD leases
deadline`. Redis runs a script atomically (single-threaded), so the id is always in `ready`, `leases` or `delayed`.
A **reaper** returns expired leases. Times come from Redis `TIME` and Mongo `$$NOW`, never worker clocks (clock skew).

### 6.6 Crash recovery: a worker is killed mid-task
The MongoDB lease (`timeoutMs + grace`) expires. The next worker's claim matches "RUNNING with an expired lease"
(**takeover**): `attempt + 1`, `leaseToken + 1`, and the old attempt is marked ABANDONED. If the dead worker comes back
and reports, its old `leaseToken` fails the CAS (**fencing token**, which prevents the ABA problem a name-only lock
has). Smoke-tested with `kill -9`: B and C re-ran as attempt 2 and the run completed.

### 6.7 Reconciler: MongoDB is the truth
Every few seconds (in each worker, which is safe because every step is CAS or idempotent):
1. READY too long (crash between commit and dispatch) → dispatch
2. QUEUED too long (Redis down or lost data) → enqueue again (deduped)
3. RUNNING with an expired lease → enqueue for takeover
4. RETRYING overdue (lost wake-up) → enqueue

Tested: wipe all Redis keys mid-run, and the reconciler rebuilds the queue. Redis down during `POST /run` still returns 202.

### 6.8 Retries
- **Classification:** transient by default (network errors, timeouts). `NonRetryableError` for bad input, business rules or a missing handler.
- **Backoff:** `random(0, min(60s, base × 2^(n−1)))`, i.e. **full jitter**. Without jitter, 1,000 tasks that failed together retry at the same instants: a retry storm that knocks the dependency over again.
- **Exhausted** → DEAD_LETTER (parked for humans), then fail-fast for the run.
- **Poison pill:** takeovers count as attempts, so a task that keeps crashing its worker is dead-lettered instead of looping forever.
- **Bug I found:** the retry was scheduled while the id was still leased. Dedupe dropped it, then the worker's `ack` erased it. The fix: `enqueueDelayed` moves leased → delayed, and `ack` only clears membership it still owns. There's a regression test.

### 6.9 Idempotency
- The `Idempotency-Key` is stored **on the execution** with a unique partial index `(triggeredBy, idempotencyKey)`. Creating the run and remembering the key are one atomic insert, so there's no half-written reservation record. 5 concurrent identical requests → 1 run.
- **At-least-once, not exactly-once.** A task may be *delivered* twice (lease expiry, duplicate enqueue), but CAS and fencing mean its result is *applied* once. A handler's external side effects (e.g. sending an email) could still repeat. Handlers must be idempotent for that, which isn't enforced.

### 6.10 Security
bcrypt (cost 12, 72-byte limit enforced) · access JWT 15m (stateless) + refresh 7d (checked against
`tokenVersion`) · separate secrets + `type` claim + HS256 pinned (blocks `alg:none` and token confusion) · identical
401 **and equal timing** for unknown email vs wrong password (a dummy hash computed at startup; I found and fixed a
first-request timing leak) · zod allowlists (mass assignment) · RBAC permission table (deny by default) ·
**ownership inside the query**, so a foreign object returns 404 (BOLA/IDOR) · pino redaction · helmet · body limit.

---

## 7. Failure scenarios (all tested or smoke-tested)
| Scenario | What happens |
|---|---|
| Crash while creating a run | the transaction rolls back, so there's no half-created run |
| Crash after commit, before dispatch | the task stays READY and the reconciler dispatches it |
| Worker dies after popping, before the Mongo claim | the Redis lease expires, the reaper requeues it, it completes (attempt 1) |
| Worker dies mid-handler | the Mongo lease expires, takeover as attempt 2, and the zombie's report is fenced |
| Worker dies after reporting, before ack | requeued → the next claim sees COMPLETED → acked and dropped (no double run) |
| Redis down at `POST /run` | 202, the task stays QUEUED in Mongo, and the reconciler enqueues it when Redis is back |
| Redis loses all data | the reconciler rebuilds the queue from Mongo |
| MongoDB down | readiness returns 503, requests fail with 500, workers error out and retry via leases (no replica failover locally) |
| Duplicate completion report | no-op (CAS) |
| Task keeps timing out | retries with backoff → DEAD_LETTER → run FAILED |
| SIGTERM during a task | the worker stops claiming, finishes and reports, then exits. If that's too slow, a forced exit hands off via the lease |

## 8. Trade-offs and alternatives
- **Why not Kafka as the queue?** No per-message ack, no visibility timeout, no delayed delivery, and a slow message blocks its partition. Kafka suits event streams (planned, not built).
- **Why not MongoDB as the queue?** Idle workers would poll the primary database. Redis gives atomic pop + lease in memory.
- **Why not BullMQ?** It would work in production. I built the queue to understand and demonstrate leases, reapers and Lua atomicity. BullMQ uses similar ideas.
- **Why not Temporal?** It's the production-grade answer (durable execution, event history). This project is a much simpler version of the same "state lives in durable storage, not in the orchestrator's memory" idea.
- **Polling vs blocking claims:** Lua can't block. `BLMOVE` can't set a lease deadline atomically. Polling costs a few requests per second per idle loop.
- **Optimistic concurrency on workflow edits** (a `version` field, stale edits get 409) instead of locks held while a user edits.
- **Offset pagination** is simple but slow on deep pages. Cursor pagination is the upgrade.

## 9. Scaling story
- **Workers:** add processes, since they're stateless. Measured locally: 3 processes × concurrency 2 ran six 1-second tasks in ~1.2 s (a laptop sanity check, not a benchmark).
- **API:** stateless (JWT), so put it behind a load balancer. `/ready` handles draining.
- **Bottlenecks to name:** the single Redis node (use replicas/Sentinel, or shard queues by key prefix); the MongoDB primary for writes (shard `tasks` by `executionId`); the hot execution document for huge fan-outs (shard the counter); polling cost with many idle workers.

---

## 10. Q&A (short ideal answers)
1. **What's a DAG, and why does it have to be acyclic?** It's a directed graph with no cycles. A cycle means tasks wait on each other forever.
2. **How do you detect a cycle?** Kahn's algorithm: if the emitted count is less than n, there's a cycle. A 3-colour DFS names it.
3. **How do independent tasks run in parallel?** Every task whose `remainingDeps` hits 0 is enqueued, and separate worker loops and processes claim them concurrently.
4. **What's a critical path?** The longest dependency chain. It's the lower bound on sequential steps even with unlimited workers.
5. **Why MongoDB?** Document-shaped data, atomic conditional updates, and transactions on a replica set.
6. **Why Redis on top of MongoDB?** For fast atomic queue operations and leases without polling the primary database. It can be rebuilt from Mongo.
7. **Why do you need both?** Mongo is the truth and Redis is coordination. If they disagree, the reconciler makes Redis match Mongo.
8. **How do you prevent two workers running one task?** An atomic Redis pop, then a Mongo CAS claim. Only one wins, and a lease plus fencing token protect the result.
9. **What's a lease?** Ownership with a deadline. If it isn't renewed or finished by then, the owner is presumed dead.
10. **What's a fencing token?** A counter incremented on each claim. Writes must present the current value, so a stale owner is rejected.
11. **What's the ABA problem here?** The same worker name re-acquires a task later, and its old attempt's write would pass a name-only check.
12. **Worker crashes, then what?** The lease expires, another worker takes over (attempt + 1), and the old attempt is ABANDONED and fenced.
13. **At-least-once or exactly-once?** At-least-once delivery, with results applied once via CAS. Not exactly-once end to end.
14. **Why is exactly-once hard?** You can't atomically commit an external side effect together with your own state. There are crash windows between them.
15. **What's write skew?** Two transactions read overlapping data, write disjoint documents, and together violate an invariant.
16. **How did you fix it?** A shared counter document that both must write, turning it into a detectable conflict.
17. **Why a transaction when starting a run?** So the execution and its tasks exist together or not at all.
18. **Why dispatch after commit, not inside?** Redis isn't part of the Mongo transaction. Writing the durable state first means a crash only loses a dispatch, which the reconciler recovers.
19. **Why ack after reporting?** A crash before the ack means redelivery, which is harmless. Acking first could lose the result.
20. **Retries can make things worse. How?** Retry storms amplify load on a failing dependency. Mitigate with backoff, jitter, max attempts and non-retryable classification.
21. **Why jitter?** It de-synchronises clients that failed at the same time.
22. **What goes to the DLQ?** Transient failures that exhausted their attempts, and poison pills. Non-retryable failures go to FAILED.
23. **What's a poison pill?** A task that crashes its worker every time. Handled by counting takeovers as attempts.
24. **How is `/run` idempotent?** Through a key stored on the execution under a unique index: replay the same request, 422 on a different one.
25. **What if the client sends the same key with a different body?** 422. Replaying the old response would hide a client bug.
26. **Liveness vs readiness?** Liveness never checks dependencies (restarting can't fix Mongo). Readiness does, and it also fails during shutdown to drain traffic.
27. **Graceful shutdown?** Stop accepting or claiming, finish in-flight work, close connections, and force-exit after a timeout.
28. **Why validate env vars at boot?** Fail fast and loudly, rather than failing on the first request.
29. **How do you stop BOLA/IDOR?** Put the ownership filter inside every query, and return 404 for foreign ids.
30. **Why 404 and not 403?** 403 confirms the id exists.
31. **JWT: signed vs encrypted?** Anyone can read the payload, but nobody can change it undetected. Never put secrets in it.
32. **How do you revoke a JWT?** Short access TTL, plus refresh checked against `tokenVersion`, which logout bumps.
33. **Why separate access and refresh secrets?** So a refresh token can never verify as an access token (token confusion bypasses revocation).
34. **Timing attack on login?** Always do one bcrypt compare, using a dummy hash for unknown emails.
35. **Mass assignment?** zod allowlists. The role is always set by the server.
36. **Why is bcrypt slow, and what does that cost you?** It defeats offline brute force. The cost is CPU and event-loop blocking, which is a DoS risk that rate limiting mitigates.
37. **How is a concurrent registration race handled?** The unique index decides. The duplicate-key error is mapped to 409 (no racy findOne pre-check).
38. **Optimistic vs pessimistic locking?** Optimistic: a version check at write time, conflict → 409. No lock is held during a long user edit.
39. **How do you scale horizontally?** Stateless API and workers, with shared state only in Mongo and Redis.
40. **What if Redis goes down?** Runs still get created (202). Workers back off. The reconciler catches up when Redis returns.
41. **What if MongoDB goes down?** Nothing progresses (it's the truth). Readiness returns 503. Production needs a 3-node replica set.
42. **How do you debug a stuck run?** `GET /executions/:id` shows task states and attempts. `taskexecutions` has the attempt history. Logs carry `requestId`, `executionId` and `taskKey`. Check for READY/QUEUED older than the stale threshold and for expired leases.
43. **Why a Lua script and not MULTI/EXEC?** A script can branch on data it reads (LPOP result → ZADD). MULTI can't use intermediate results.
44. **Why server clocks?** Worker clocks drift. One authoritative clock means everyone agrees when a lease expires.
45. **Why store task definitions on the execution's tasks?** It's a snapshot, so editing a workflow never changes a run in progress.
46. **How is data passed between tasks?** A handler receives `parents: { key: output }`.
47. **How are timeouts enforced?** `Promise.race` plus an `AbortSignal`. Racing only stops the waiting, and abort asks the work itself to stop.
48. **Why did Mongoose's `minimize` matter?** It silently dropped `{}` from task outputs (data corruption), fixed with `minimize: false`, which an e2e test caught.
49. **What did mutation testing show you?** Most guards are load-bearing. One guard was redundant (defence in depth), which I documented honestly.
50. **What would you add next?** Heartbeats + worker registry, pause/cancel endpoints, Kafka lifecycle events via a transactional outbox, metrics, Docker images, and a load benchmark.

## 11. Coding questions to practise (from this project)
1. Topological sort / cycle detection (above). **O(V+E).**
2. Return the parallel levels of a DAG (wave-by-wave Kahn).
3. `computeBackoff(attempt, base, max)` with full jitter.
4. `withTimeout(promise, ms)`, including clearing the timer in `finally`.
5. An in-memory queue with leases: `claim(leaseMs)`, `ack(id)`, `requeueExpired(now)` (Map plus a sorted structure).
6. A worker pool with a concurrency limit (N loops pulling from a shared queue).
7. CAS: implement `transition(id, from, to)` over a Map and show that two concurrent callers produce one winner.
8. An idempotency store: `handle(key, requestHash, fn)` that returns the stored result, or throws on a hash mismatch.

## 12. Debugging scenarios (and what to check)
- **Run stuck RUNNING, all tasks COMPLETED** → the `pendingTasks` counter (write skew if you used counting).
- **Task stuck QUEUED** → is it in Redis (`LRANGE wf:q:ready`)? Is a worker running? Did the reconciler log anything?
- **Task stuck RETRYING** → the delayed ZSET, `retryAt`, and whether the reconciler sweep is running.
- **Same task ran twice** → check `taskexecutions`: an ABANDONED attempt means a lease expired (the handler was slower than timeout + grace).
- **All runs FAILED instantly** → an unknown task type (non-retryable) or a missing worker handler.

---

## 13. Resume bullets (facts only)
- Built a **distributed DAG workflow engine** (Node.js, Express, MongoDB, Redis) with parallel execution of independent tasks, transactional state transitions and **crash recovery via leases and fencing tokens**.
- Designed a **reliable Redis task queue** with atomic Lua claim + lease, a reaper, delayed retries and dedupe, fixing a lost-job bug in a previous queue design.
- Implemented **retries with exponential backoff and full jitter**, transient/permanent error classification, dead-lettering and a poison-pill guard.
- Prevented concurrency anomalies (diamond-dependency race, **write skew** on completion, duplicate deliveries) using MongoDB transactions and compare-and-set updates, **verified by race and mutation tests**.
- **225 automated tests** (Jest + Supertest) including concurrent-request races and end-to-end crash-recovery scenarios; JWT auth, RBAC and object-level authorization.

### Never claim (not built, or not measured)
- ❌ Kafka, event streaming, the transactional outbox
- ❌ Any AI: LLM providers, Ollama integration, RAG, Qdrant, embeddings, agents, model routing, LangChain
- ❌ Scheduled or cron workflows, pause/resume/cancel endpoints, human-in-the-loop approvals
- ❌ Distributed locks, heartbeats, a worker registry, rate limiting, Swagger, Docker images for the app
- ❌ **Exactly-once** processing (it's at-least-once delivery with apply-once state changes)
- ❌ Any throughput, latency or "X% improvement" number. **Not benchmarked.** The ~1.2 s fan-out figure is a single local sanity check, not a benchmark.
- ❌ High availability (MongoDB and Redis are single-node locally)

## 14. Live demo script (5 minutes)
```bash
npm run infra:up
npm run dev                  # terminal 1
npm run worker               # terminals 2 and 3
ADMIN_EMAIL=a@b.co ADMIN_PASSWORD='long-password' npm run create-admin
# login → POST /workflows (diamond with delay tasks) → POST /workflows/:id/run → GET /executions/:id
# kill -9 one worker mid-run → watch attempt 2 take over after the lease
# POST /run twice with the same Idempotency-Key → same execution id
```
