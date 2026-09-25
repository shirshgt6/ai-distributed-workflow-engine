# Redis: the task queue

> **Implemented (Phase 6):** a reliable queue with leases, a reaper, delayed tasks and dedupe (`src/queues/taskQueue.js`), plus a queue worker (`src/workers/queueWorker.js`).
> Workers run as **separate processes** (`npm run worker`, Phase 7). Retries use the delayed set (Phase 8).
> **Not yet:** distributed locks, rate limiting, worker heartbeats and registry.

## Responsibilities

| MongoDB | Redis |
|---|---|
| **Truth**: what state is each task in? | **Coordination**: which task id should a worker take next? |
| Durable, transactional | Fast, atomic, in memory (AOF persistence on) |
| Loses nothing | Can be rebuilt from MongoDB by the reconciler |

**Why not use MongoDB as the queue?** Every idle worker would poll with a query, and "pop exactly one" needs a
`findOneAndUpdate` per claim, all hitting the database that also serves the API. Redis list and sorted-set
operations are O(1) or O(log n) in memory, and Lua scripts make multi-step queue moves atomic.

**Why not Kafka?** Kafka has no per-message ack, no visibility timeout and no delayed delivery, and a slow message
blocks its whole partition. Kafka is planned for lifecycle *events* (Phase 11), not task dispatch.

## Keys (prefix `wf:q`)

| Key | Type | Holds |
|---|---|---|
| `wf:q:ready` | LIST | task ids waiting for a worker, FIFO (`RPUSH` in, `LPOP` out) |
| `wf:q:leases` | ZSET | ids a worker has claimed; score = lease deadline (ms) |
| `wf:q:delayed` | ZSET | ids that become ready later; score = ready time (ms). Used by retries in Phase 8 |
| `wf:q:members` | SET | every id currently in ready ∪ leases ∪ delayed, used for dedupe |

Only **ids** are stored in Redis. Everything else about a task lives in MongoDB.

## Operations (each one is a Lua script, so it's atomic)

| Operation | Script does | Why atomic matters |
|---|---|---|
| `enqueue(id)` | `SADD members`; only if new, `RPUSH ready` | the reconciler can re-enqueue freely without creating duplicates |
| `claim(leaseMs)` | `LPOP ready` + `ZADD leases now+leaseMs` | **the fix for Project 1's lost jobs**: an id is always in `ready` or in `leases`, never neither |
| `extendLease(id, ms)` | only if still leased: move the deadline | a worker whose lease was reaped learns it no longer owns the task |
| `ack(id)` | only if the lease still exists: `ZREM leases` + `SREM members` | a late ack must not erase a retry or a requeued entry |
| `requeueExpired()` | expired leases → `ready` | reaper. Concurrent reapers move each id once |
| `enqueueDelayed(id, ms)` | if the id is **leased** (the worker whose attempt just failed), move it from leases to delayed; otherwise dedupe as usual | the retry must survive the worker's subsequent `ack` |
| `promoteDue()` | delayed ZSET → `ready` when due | Project 1 did `ZRANGEBYSCORE` then `ZREM` as separate round trips |

**Time comes from Redis (`TIME` inside the script).** Workers on machines with skewed clocks still agree on when a
lease expires. The MongoDB lease uses MongoDB's clock (`$$NOW`) for the same reason.

## Worker loop (`src/workers/queueWorker.js`)
```
claim id (Redis: pop + 30s lease)          nothing?  sleep pollIntervalMs (200ms)
engine.startTask (MongoDB claim)           null?     ack and drop (finished, cancelled, or live elsewhere)
extendLease to task.timeoutMs + grace
run handler → report to MongoDB
ack   ← LAST, only after MongoDB has the result
```
- **Ack last.** A crash after reporting but before ack is harmless: the lease expires, the id is requeued, and the
  next MongoDB claim returns null, so it's acked. Acking first could lose the task.
- **Polling, not blocking.** Lua can't block. `BLMOVE` could block, but can't set a lease deadline atomically. Idle
  cost is concurrency ÷ poll interval requests per second (e.g. 20/s), which is negligible for Redis.
- **Redis unreachable:** claim errors back off exponentially (capped at 5s). A task being processed keeps its lease,
  and if it can't be finished, it expires and is retried.
- **Maintenance:** every worker runs the reaper and the delayed promoter every second. They're atomic, so running them
  from several workers at once is safe.

## Two leases, and why
| | Redis lease | MongoDB lease |
|---|---|---|
| Set by | `claim` (30s), then extended to `timeoutMs + grace` | `claimTask`: `$$NOW + timeoutMs + grace` |
| Protects | the gap between "popped from Redis" and "claimed in MongoDB" | the task while its handler runs |
| On expiry | reaper puts the id back in `ready` | another worker's claim may **take over** (`attempt + 1`, `leaseToken + 1`, old attempt ABANDONED) |

A healthy worker's handler is stopped by its own timeout before either lease runs out.

## When Redis and MongoDB disagree
The reconciler (`engine.reconcile`, every `RECONCILE_INTERVAL_MS`) treats MongoDB as the truth:
1. READY for too long: dispatch it (crash between commit and dispatch)
2. QUEUED for too long: `enqueue` again (Redis was down during dispatch, or lost data). A no-op if the id is still there.
3. RUNNING with an expired lease: `enqueue` so a worker can take it over

## Failure scenarios (tested or smoke-tested)
| Scenario | Outcome | Evidence |
|---|---|---|
| Worker pops a task and dies before claiming it in MongoDB | lease expires → requeued → completed | `recovery.test.js` |
| Worker dies mid-handler | MongoDB lease expires → takeover as attempt 2; the zombie's late report is fenced | `recovery.test.js`, and smoke test with `kill -9` |
| Redis data wiped mid-run | reconciler rebuilds the queue from MongoDB | `recovery.test.js` |
| Redis down when a run is requested | API still returns 202 (MongoDB committed); run completes once Redis is back | smoke test |
| 50 concurrent claims on 20 tasks | each claimed exactly once | `taskQueue.test.js` |

## Known limitations
- **Heartbeats (Phase 10):** the running lease is a short `LEASE_TTL_MS`, renewed every TTL/3 in both MongoDB (fenced
  by `leaseToken`) and Redis while the handler runs. A dead worker is noticed within one TTL, even for long tasks.
- **Lock (`src/queues/lock.js`):** `SET NX PX` with a random token, compare-and-delete release, and an INCR fencing
  counter. This is a single-node lock, not Redlock. A holder paused past the TTL can still act, so callers must
  tolerate a rare double holder (the scheduler does, through idempotency keys).
- **Horizontal scaling (smoke-tested):** 3 worker processes × concurrency 2 ran six 1-second tasks of one run in
  about 1.2 s of wall-clock time, on one laptop, with each worker taking 2. That's a local sanity check, not a benchmark.
- **Single Redis node.** No replication or failover. The reconciler limits the damage of data loss, but not downtime.
