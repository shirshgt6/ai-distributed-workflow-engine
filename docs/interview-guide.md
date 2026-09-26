# Interview Guide: AI-Powered Distributed Workflow Orchestration Engine

Everything here is implemented and tested in this repo. Section 12 lists what you must **not** claim.
Companion docs: [phase-summaries.md](phase-summaries.md) (real-life analogy per phase), [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## 1. Pitches

### 30 seconds
> "I built a distributed workflow engine in Node.js. Workflows are DAGs of tasks, including AI tasks: LLM classification
> and routing, RAG over Qdrant, a tool-using agent, and human approval steps. Independent tasks run in parallel on
> horizontally scalable workers. MongoDB is the source of truth, Redis is a reliable lease-based queue, and Kafka carries
> lifecycle events through a transactional outbox. I chaos-tested it: killing 14 workers and restarting Redis during 40
> runs, every one of 280 tasks completed exactly once."

### 1 minute
Add: *"Every state change is a MongoDB transaction or a compare-and-set, with fencing tokens so a dead worker's late
report is rejected. Claims are one atomic Redis Lua script, so a task id can never be lost between 'popped' and 'recorded'.
Workers heartbeat their leases, and a crashed worker's task is taken over within 15 seconds. Retries use exponential backoff
with jitter and dead-lettering. The AI layer sits behind a provider interface, with a fallback chain and circuit breakers,
every LLM output is schema-validated and repaired, and every call is recorded with tokens, latency and cost. Security:
JWT + RBAC + ownership checks in every query, and Redis sliding-window rate limits. 381 automated tests."*

### 3 minutes
Use the 1-minute pitch, then go deep on **one race** (§4.3 write skew), **one crash** (§4.6 takeover + fencing), and **one AI
control** (§4.12 agent safety or §4.11 RAG citations). Interviewers dig; those three show depth.

---

## 2. Architecture and why each technology
See the diagram in [ARCHITECTURE.md](../ARCHITECTURE.md).

| Tech | Job here | Why it and not an alternative |
|---|---|---|
| MongoDB (replica set) | source of truth | document-shaped workflows; atomic conditional updates; multi-document transactions |
| Redis | queue, leases, delayed retries, locks, heartbeats, rate limits | in-memory atomic ops + Lua; rebuildable from Mongo |
| Kafka | lifecycle events for independent consumers | replayable log, consumer groups, per-key ordering. Not a task queue: no per-message ack, visibility timeout or delay; head-of-line blocking per partition |
| Qdrant | vector search | ANN index + payload filter (tenant isolation inside the query) |
| Ollama | local LLM + embeddings via an OpenAI-compatible API | free, offline; the same code works with any OpenAI-compatible host |
| Express, zod, pino, Jest | API, validation, logs, tests | standard, small, explainable |

**Why not MongoDB as the queue?** Idle workers would poll the primary DB, and every claim becomes a `findOneAndUpdate`. Redis
does pop + lease atomically in memory. **Why both Redis and Kafka?** Different semantics: a work queue (exactly one consumer
per task, ack, lease, delay) vs an event log (every consumer group sees every event, replayable).

---

## 3. Lifecycles

### Request: `POST /workflows/:id/run`
requestId → structured log → helmet → body limit → **rate limit** (per user) → **JWT** (signature/expiry/type, no DB hit) →
**RBAC** (`workflow:run`) → **zod** → ownership (`findOne({_id, ownerId})` → 404 if not yours) → optional `Idempotency-Key` →
**one transaction**: execution + all tasks + `execution.started` outbox row → READY→QUEUED (CAS) → Redis enqueue →
**202** + `Location`. Redis down? Still 202: the run is committed, and the reconciler enqueues later.

### Task (inside a worker)
Lua claim (pop + 30 s lease) → `startTask`: QUEUED/RETRYING/expired-RUNNING → RUNNING, attempt+1, leaseToken+1,
`leaseExpiresAt = $$NOW + 15s` → attempt row → handler `{config, input, parents, attempt, ownerId, signal}` under a timeout, in an
AsyncLocalStorage context (for AI metrics), renewing the lease every 5 s → **completeTask** (txn: CAS COMPLETED by leaseToken;
pendingTasks−1; children remainingDeps−1 → READY; last task → run COMPLETED; outbox) **or failTask** (txn: RETRYING + delayed
enqueue / FAILED / DEAD_LETTER + fail-fast) **or suspendForApproval** → **ack last**.

---

## 4. Deep dives

### 4.1 DAG validation: Kahn O(V+E), DFS to name the cycle
```js
function topoSort(tasks) {
  const indeg = new Map(), kids = new Map();
  for (const t of tasks) { indeg.set(t.key, t.dependsOn.length); kids.set(t.key, []); }
  for (const t of tasks) for (const d of t.dependsOn) kids.get(d).push(t.key);
  const q = tasks.filter(t => indeg.get(t.key) === 0).map(t => t.key), order = [];
  for (let h = 0; h < q.length; h++) {
    order.push(q[h]);
    for (const c of kids.get(q[h])) { indeg.set(c, indeg.get(c) - 1); if (indeg.get(c) === 0) q.push(c); }
  }
  return order.length === tasks.length ? order : null; // leftovers => cycle
}
```
Also rejected: self-dependency, unknown dependency, duplicate key, **duplicate dependency** (`[B,B]` → remainingDeps 2, and the child waits forever).
Waves give the parallel levels, and `levels.length` is the critical path in tasks.

### 4.2 Compare-and-set
`updateOne({ _id, status: "RUNNING", leaseToken: 7 }, { $set: { status: "COMPLETED" } })`. If `modifiedCount === 0`, someone
else won, so don't act. Used for every transition, workflow edits (version), approvals, and the scheduler's nextRunAt.

### 4.3 Diamond race and write skew
- **B and C finish together:** both transactions write D and the execution document → WriteConflict → one retries → D is promoted exactly once.
- **Write skew:** X and Y are both last. "Count unfinished tasks" in each snapshot sees the other RUNNING, so **nobody completes
  the run**. That was reproduced with a mutation test. The fix is a `pendingTasks` counter on the execution document, so both write
  the same document and the conflict becomes detectable.

### 4.4 Reliable queue (fixes a lost-job bug in my previous project)
`BZPOPMIN` → crash before recording = a job lost forever. Now one Lua script does `LPOP ready` + `ZADD leases deadline`, so the id
is always somewhere. A reaper requeues expired leases. There's dedupe through a members SET. `ack` only after MongoDB has the
result, and only if we still own the lease. Clocks come from Redis `TIME` and Mongo `$$NOW`, never from workers.

### 4.5 Retries
Transient by default; `NonRetryableError` for business/validation errors. `delay = random(0, min(60s, base·2^(n−1)))` (full
jitter, to avoid retry storms). Exhausted → DEAD_LETTER. The **poison-pill guard** counts takeovers as attempts. **Bug found:** a
retry scheduled while the id was still leased was dropped by dedupe and then erased by the worker's ack. Fix: move leased →
delayed, and ack clears membership only if it still owns the lease.

### 4.6 Crash recovery
Heartbeat renews the lease every 5 s. A dead worker's lease lapses (≤ 15 s), the next claim matches "RUNNING and expired" →
**takeover** (attempt+1, leaseToken+1, old attempt ABANDONED) → the zombie's late report fails the fencing check.
The reconciler repairs READY (crash after commit), QUEUED (Redis lost it), RUNNING (expired), RETRYING (lost wake-up) and
expired approvals.

### 4.7 Idempotency
- **Runs:** the key is stored on the execution under a unique partial index `(triggeredBy, key)`. Same request → the same run
  + `Idempotent-Replayed`; a different request → 422. It's atomic with the insert (no half-written reservation).
- **Scheduler:** `schedule:<workflowId>:<slot>`.
- **Consumers:** a processed-event row in the same transaction as the effect.
- **Enqueue:** a members SET. The honest summary: **at-least-once delivery, state changes applied once.**

### 4.8 Distributed lock
`SET key token NX PX ttl`; release/extend with compare-and-delete Lua; an INCR fencing counter. It's used for scheduler and
outbox-relay leader election. **A lock alone isn't correctness:** a paused holder can outlive its TTL. The real guarantees
are the idempotency keys (the scheduler) and at-least-once tolerance (the relay).

### 4.9 Kafka via a transactional outbox
State change + event row in one transaction → the relay (leader) publishes (key = executionId, so there's order per run) → marks
published. Crash in between → republish, so the consumer dedupes. Real round-trip test: 8 messages for 4 events → 4 applied,
4 skipped.

### 4.10 AI layer: interface, validation, routing, fallback
Provider interface (`chat`, `embed`) → OpenAI-compatible over fetch (Ollama) / mock → **fallback chain** (retryable errors only;
there's no fallback for embeddings) with **circuit breakers** → **observed** (an AIExecution row per call). Every model output goes
through `generateStructured` (JSON Schema in the prompt, JSON mode, zod, repair ×2, refuse). Classification → **rule-based
router**: tools → agent, documents → RAG, hard → large model, else small.

### 4.11 RAG
clean → hash dedupe → chunk (800/100, LangChain splitter) → embed (768-d) → Qdrant (collection per model; ownerId filter
in the query) + Mongo text. Answer: top-K ≥ threshold → numbered `<document>` context → `{answer, citations: enum(S1..Sk),
grounded}`. A hallucinated citation fails validation and is repaired. No evidence → a fixed "not enough information"
answer with **no LLM call**.

### 4.12 Agent
The model proposes `{tool, args}`, and code decides: allowlist enum ∩ role permissions, ownerId from the task (never args), zod
args, per-tool timeout, truncated `<tool_result>`, max iterations, loop guard, overall timeout. Read-only tools only; the
calculator is a parser, never `eval`.

### 4.13 Human-in-the-loop
The handler returns `AwaitApproval` → a transaction parks the task (no worker is held) + an ApprovalRequest with context →
approve/reject = CAS `PENDING→decision` + task transition in one transaction (reusing the normal success/fail helpers) →
timeout via the reconciler. 3 approves + 3 rejects at once → one winner, five 409s.

### 4.14 Security
bcrypt; access 15 m + refresh with `tokenVersion`; pinned HS256, separate secrets, `type` claim; equal timing on login; zod
allowlists; RBAC table; **ownership in every query → 404**; **Redis sliding-window rate limits** (atomic Lua; login per
IP+email and per IP, fail closed); NoSQL injection blocked by types; body limits; prompt-injection controls in code;
secret scanner.

### 4.15 Observability
JSON logs with reqId/userId/executionId/taskKey; an AIExecution row per LLM call (AsyncLocalStorage attribution; no prompt text);
`/analytics/ai` (p95 latency, error rate, tokens, cost) and `/analytics/workflows` (success rate, durations, retries,
failing types); `GET /workers`. There's no OpenTelemetry.

---

## 5. Failure scenarios (all tested or smoke-tested)
| Scenario | Outcome |
|---|---|
| Crash while creating a run | transaction rollback, so no partial run |
| Crash after commit, before enqueue | the reconciler dispatches the READY task |
| Worker dies after popping, before the Mongo claim | the Redis lease expires → requeued |
| Worker killed mid-task | the heartbeat stops → takeover as attempt 2; the zombie is fenced |
| Worker dies after reporting, before ack | redelivered → claim returns null (already done) → acked |
| Redis restarted / data wiped | the reconciler rebuilds the queue from Mongo (chaos-tested) |
| Redis down at `POST /run` | 202; enqueued later |
| Redis down during login | 503 (limiter fails closed) |
| Kafka down | events wait in the outbox; tasks unaffected |
| Primary LLM down | fallback provider; the circuit opens; a task-level retry if all are down |
| LLM returns malformed JSON | repair turns → valid, or a non-retryable failure |
| Model cites a source it wasn't given | enum validation → repair |
| Qdrant down | `/ready` 503; RAG tasks fail (retryable) |
| Two approvers click at once | one wins, the other gets 409 |
| Two schedulers (even without the lock) | one run per slot (idempotency key) |
| SIGTERM during a task | stop claiming, finish, report, exit; the lease covers overruns |

---

## 6. Scaling
- **Workers:** stateless, so add processes/replicas (`--scale worker=5`). Measured: 3 processes × concurrency 2 ran six 1-s tasks in
  ~1.2 s on a laptop (a sanity check, not a benchmark).
- **API:** stateless JWT, so put it behind a load balancer; set `TRUST_PROXY`.
- **Bottlenecks to name:** single-node Redis (Sentinel/Cluster, shard queues); the Mongo primary for writes (shard tasks by
  executionId); the hot execution document for huge fan-outs (shard the counter); polling cost with many idle workers
  (BLMOVE + a separate lease step, or push notifications); Kafka partitions bound consumer parallelism; Qdrant sharding/replicas.

## 7. Trade-offs and alternatives
- **Temporal / Airflow / BullMQ:** production-grade options. I built the core to understand and explain leases, fencing,
  outbox and write skew. Temporal's event-history model is the grown-up version of "state in the DB, not in the orchestrator".
- **Central orchestrator vs choreography:** no orchestrator process here, just functions run by whoever finishes a task.
- **Optimistic concurrency** (versions, 409) over locks held during user edits.
- **Rules vs an LLM router;** a **custom agent loop vs LangChain agents;** **pgvector vs Qdrant** (pgvector if you already run
  Postgres and have modest scale).
- **Fail-fast** per run (a "continue independent branches" option isn't built).

---

## 8. Q&A (short ideal answers)

**DAG and engine**
1. Why a DAG? Dependencies must be satisfiable; a cycle means waiting forever.
2. Detect a cycle? Kahn: emitted < total. DFS with grey nodes to name it.
3. Complexity? O(V+E).
4. Parallel levels? Kahn wave by wave.
5. Critical path? The longest dependency chain, which lower-bounds sequential steps.
6. Why reject duplicate dependencies? The counter would never reach 0.
7. How do parallel tasks run? Every task whose remainingDeps hits 0 is enqueued, and many workers claim concurrently.
8. Why no central orchestrator? It would be a SPOF and a bottleneck; state lives in the DB and whoever finishes advances the run.
9. Why snapshot definitions into tasks? Editing a workflow mustn't change a running run.
10. How is data passed between tasks? `parents: {key: output}`.

**Concurrency and correctness**
11. What's CAS? An update conditional on the expected current value; 0 matched = lost the race.
12. What's write skew? Two transactions read overlapping data, write disjoint documents, and break an invariant together.
13. How did you fix it? A shared counter document, so both must write it and the conflict is detectable.
14. Why transactions if you have CAS? Multi-document changes (task + children + run + event) must be atomic.
15. Why dispatch after commit? Redis isn't in the transaction; write durable state first, and the reconciler covers crashes.
16. What's a fencing token? A counter bumped per claim; writes must carry the current one.
17. What's the ABA problem here? The same worker name re-claims; a name-only check would accept a stale write.
18. Optimistic vs pessimistic locking? A version check at write time vs holding a lock. I use optimistic for edits.
19. Why does ack happen last? Crash before ack = harmless redelivery; ack first could lose work.
20. How did you verify the race fixes? `Promise.all` race tests plus mutation tests removing each guard.

**Redis / queue / locks**
21. Why Lua? The script is atomic and can branch on intermediate results (unlike MULTI).
22. What's a lease? Ownership until a deadline.
23. What's the reaper? It moves expired leases back to ready.
24. Why server clocks? Worker clocks skew.
25. Why dedupe enqueues? The reconciler can re-enqueue freely.
26. Why poll instead of BLPOP? A blocking pop can't set the lease atomically.
27. Redlock? Not used: single-node Redis. The correctness comes from idempotency and fencing, not the lock.
28. What does the lock protect? Leader election for the scheduler and outbox relay (to avoid wasted work).
29. What if the lock holder pauses past its TTL? Two leaders; the idempotency keys and consumer dedupe absorb it.
30. Rate limit algorithm? A sliding-window log in a ZSET, atomic in Lua.

**Workers and recovery**
31. How do you scale? Stateless workers; add replicas.
32. What's a heartbeat? A periodic "alive" signal that renews the lease and the registry key.
33. Is a missed heartbeat proof of death? No, it's a failure detector; leases + fencing ensure correctness.
34. How long until a dead worker's task moves? ≤ LEASE_TTL (15 s).
35. Graceful shutdown? Stop claiming, finish in-flight, report, exit; a force-exit timer.
36. What's a poison pill? A task that kills its worker every time; takeovers count as attempts → DLQ.
37. What does the reconciler fix? Stragglers in READY/QUEUED/RUNNING/RETRYING, plus expired approvals.
38. Redis loses everything? The reconciler rebuilds from Mongo (tested).
39. Pause semantics? No new dispatch; running tasks finish; children wait for resume.
40. Cancel semantics? Everything unfinished is cancelled; running handlers abort at the next lease renewal.

**Retries and idempotency**
41. Why can retries make things worse? Retry storms amplify load on a failing dependency.
42. Why jitter? It de-synchronises clients that failed together.
43. Which errors aren't retried? Validation/business errors, a missing handler, exhausted structured output.
44. What goes to the DLQ? Transient failures that exhausted their attempts.
45. At-least-once or exactly-once? At-least-once delivery; state changes applied once.
46. Why is exactly-once hard? You can't atomically commit external side effects with your state.
47. How is `/run` idempotent? A key on the execution + unique index; replay or 422.
48. Same key, different body? 422, so client bugs aren't hidden.
49. Idempotent consumer? A processed-event row + effect in one transaction.
50. Are handlers idempotent? Not enforced; handler side effects may repeat on retry.

**Kafka**
51. Why an outbox? Update-then-publish loses events; publish-then-update emits phantoms.
52. Partition key? executionId, for per-run ordering.
53. Consumer group? Each group receives every event; partitions are split among members.
54. Offsets? Committed after processing, so a crash means redelivery (deduped).
55. Why not Kafka for tasks? No per-message ack, visibility timeout or delay; head-of-line blocking.
56. What does `idempotent: true` give you? Dedupe of producer retries within a session only.
57. Kafka down? Events wait in the outbox; work continues.
58. Relay concurrency? Leader-elected with the Redis lock.

**Scheduler**
59. How do you prevent double runs per slot? Idempotency key per slot.
60. Why start before advancing nextRunAt? A crash in between only yields a deduped retry, never a missed run.
61. Missed slots after downtime? No backfill; run once, then continue.
62. Timezones? IANA via cron-parser, validated with Intl.
63. Why reject 6-field cron? Per-second schedules are a footgun.

**AI**
64. Why a provider interface? Dependency inversion: swap vendors or mock without touching business code.
65. Why no vendor SDK? Two endpoints; full control over timeouts and errors.
66. JSON mode is enough? No: it guarantees syntax, not the schema, so validate.
67. What's a repair turn? Show the model its invalid output plus the exact errors and ask again.
68. After repairs fail? A non-retryable error.
69. Why a rule-based router? Free, instant, testable, explainable.
70. Cost vs quality? Small model by default, escalate on complexity.
71. Fallback rules? Only on retryable errors; never for embeddings.
72. Circuit breaker states? Closed → open → half-open (one trial).
73. Why never fall back embeddings? A different model means a different vector space.
74. How do you track cost? A token count × price table per model; local = 0; an estimate.
75. How do you attribute calls to tasks? AsyncLocalStorage context set by the task runner.
76. Do you store prompts? No.
77. Did few-shot help? For one real misclassified query, yes (3/3), but it's not an evaluation.
78. What's LangChain used for? Only the text splitter.
79. When is LangChain worth it? For utilities and prototyping; I keep safety-critical control flow in my own code.
80. Model quality limits? The 0.5B model misses citations and loops as an agent; the controls catch it, and a bigger model is needed.

**RAG**
81. What's an embedding? A vector whose direction encodes meaning.
82. Cosine similarity? The angle between vectors: a·b/(|a||b|).
83. Why chunk? Precise retrieval and a bounded prompt.
84. Why overlap? Facts at boundaries stay whole.
85. Top-K and threshold? Bound cost; drop irrelevant chunks.
86. Tenant isolation? An ownerId payload filter inside the Qdrant query.
87. Why keep text in Mongo? It's the truth and can be re-embedded when the model changes.
88. How does RAG reduce hallucination? Grounding, required citations, citation validation, refusal without evidence.
89. Does it eliminate hallucination? No.
90. Why Qdrant? A purpose-built ANN + filters; pgvector is fine if you already run Postgres.
91. How would you scale Qdrant? Shards + replicas, payload indexes, quantisation.

**Agent**
92. LLM vs agent? One answer vs a tool-using loop.
93. Stop conditions? Final answer, max iterations, a repeated call, a timeout, an abort.
94. Tool safety? Allowlist enum, role permissions, task-scoped ownerId, arg validation, timeouts, read-only.
95. Prompt injection via tool results? Delimited; can't add tools; code enforces scope.
96. Why no `eval` in the calculator? Model output would become code execution.
97. What happens when the agent can't finish? The task fails non-retryably.

**Human-in-the-loop**
98. How do you wait for a human without blocking? Park the task in the DB; no worker is held.
99. Concurrent approvals? CAS on PENDING, one winner.
100. Timeout? The reconciler expires it and the task fails.
101. Cancel while waiting? The approval is cancelled and a later decision gets 409.

**Security**
102. 401 vs 403? Unauthenticated vs not permitted.
103. 404 for others' resources, why? A 403 would confirm existence (BOLA).
104. Brute force? Per IP+email and per IP limits, before bcrypt.
105. Why fail closed for login? Protection mustn't vanish with Redis.
106. X-Forwarded-For? Trust it only from known proxy hops (`TRUST_PROXY`).
107. NoSQL injection? zod types reject objects; ObjectId validation.
108. JWT revocation? Short access TTL + refresh checked against tokenVersion.
109. Timing attacks on login? A dummy hash, so both paths cost one bcrypt compare.
110. Secrets? `.env` only, validated at boot, redacted in logs, a scanner before commits.

**Ops / observability / testing**
111. Liveness vs readiness? Alive vs able to serve (dependencies); readiness fails during shutdown.
112. How do you debug a stuck run? Execution API → attempts (ABANDONED/TIMED_OUT) → aiexecutions → logs by executionId → workers.
113. Metrics you'd alert on? Run failure rate, p95 task latency, LLM error rate, fallback rate, DLQ growth, UNRESPONSIVE workers.
114. How did you test crashes? Simulated deaths at exact points + a chaos script with `kill -9` and a Redis restart.
115. What's a mutation check? Remove a guard and ensure a test fails.
116. Coverage? 95% lines measured (unit + integration).
117. What did the chaos test prove? 280 tasks, 14 kills + a Redis restart, exactly one success per task.
118. Docker? One non-root image, three roles; compose profile for the full stack.
119. How do you keep the API docs honest? A test compares the OpenAPI paths with the registered routes.
120. What would you do next? HA infra, OpenTelemetry, cursor pagination, a bigger model + RAG eval set, refresh rotation, per-tenant quotas.

---

## 9. Coding questions from this project
1. Topological sort / cycle detection (§4.1). 2. Parallel levels. 3. `computeBackoff` with full jitter. 4. `withTimeout`
with timer cleanup. 5. An in-memory lease queue: `claim`, `ack`, `requeueExpired`. 6. A worker pool with a concurrency limit.
7. `transition(id, from, to)` with CAS over a Map. 8. An idempotency store (hash check). 9. A sliding-window rate limiter.
10. Cosine similarity. 11. Validate LLM JSON with a schema + one repair attempt. 12. A safe arithmetic parser (recursive descent).
13. A circuit breaker state machine. 14. Rule-based router. 15. Dedup consumer by eventId.

## 10. System design questions to rehearse
- Design this for 10k runs/min: queue sharding, Mongo sharding by executionId, sharded counters, Kafka partitions, autoscaling workers.
- Multi-region: single-writer per run (home region), the outbox to replicate events, no cross-region transactions.
- Add a "continue on failure" policy: a per-workflow flag; failTask marks only descendants CANCELLED.
- Add sub-workflows: a task type that starts a child run and completes when the child completes (via events).
- Add priority queues: ZSET scored by priority+time instead of a LIST; beware starvation.
- Make the LLM cost-aware: a budget per tenant in Redis, a router downgrade when over budget.

## 11. Debugging scenarios
- Run stuck RUNNING, all tasks done → pendingTasks (write skew).
- Task stuck QUEUED → in Redis? A worker running? Reconciler logs?
- Task ran twice → attempts show ABANDONED = the handler exceeded its lease (no heartbeat renewal?).
- Retry never happened → the delayed set; RETRYING + retryAt; the reconciler sweep.
- RAG says "not enough information" but the doc has it → retrieval scores vs threshold; the model not citing (small model).
- 429 on login during testing → the rate limiter doing its job.
- Container can't create admin → a dev dependency used in production code (real bug found).

---

## 12. Resume bullets (measured facts only)
- Built a **distributed DAG workflow engine** (Node.js, MongoDB, Redis, Kafka) with parallel task execution, transactional
  state transitions, lease/heartbeat-based crash recovery and **fencing tokens**. **Chaos-tested: 280 tasks across 40 runs
  completed exactly once despite 14 worker kills and a Redis restart.**
- Designed a **reliable Redis task queue** (atomic Lua claim + lease, reaper, delayed retries with jittered backoff,
  dead-lettering), fixing a lost-job failure mode of a previous design.
- Implemented **Kafka lifecycle events via a transactional outbox** with idempotent consumers, and **cron scheduling** with
  per-slot idempotency.
- Built an **AI task layer**: provider abstraction with fallback + circuit breakers, schema-validated LLM output with
  repair, rule-based model routing, **RAG on Qdrant** with owner-isolated retrieval and validated citations, a
  **permission-bounded tool-using agent**, and **human-in-the-loop approvals**. Every LLM call is tracked (tokens, latency, cost).
- Security: JWT + RBAC + object-level authorization, Redis sliding-window rate limiting, prompt-injection controls.
  **381 automated tests (95% line coverage)** including concurrency race tests and mutation checks.

## 13. Never claim
- ❌ **Exactly-once** processing (it's at-least-once + apply-once)
- ❌ **Throughput / latency / scale numbers**: none were benchmarked. The ~1.2 s fan-out and the chaos timings are sanity checks.
- ❌ **High availability / production deployment**: all infrastructure is single-node locally
- ❌ **AI accuracy / quality numbers**: there's no evaluation set. The 0.5B model is weak at citations and agent completion
- ❌ Azure OpenAI or any hosted provider **tested** (the code is OpenAI-compatible; only local Ollama was used)
- ❌ OpenTelemetry tracing, Prometheus, PDF ingestion, re-ranking, hybrid search, refresh-token rotation, CORS, separation of duties
- ❌ "Uses LangChain agents / chains" (only the text splitter)
