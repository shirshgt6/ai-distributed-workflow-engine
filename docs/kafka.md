# Kafka: lifecycle events (Phase 11)

## What Kafka is used for, and what it isn't
- **For:** a stream of *facts* ("execution.started", "task.completed"...) that any number of independent consumers
  can read, each at its own pace, replayable from the log.
- **Not for:** dispatching tasks to workers. That's the Redis queue (per-message ack, leases, delays; see redis.md).

## Pipeline
```
engine transaction ──(same txn)──► outboxevents (MongoDB)
                                        │  relay (inside workers; one leader via Redis lock)
                                        ▼
                            Kafka topic "workflow-events" (3 partitions, key = executionId)
                                        │  consumer group "analytics" (npm run consumer:analytics)
                                        ▼
                     processedevents (dedupe) + eventstats (counts), in one MongoDB transaction
```

## Events
`execution.started`, `execution.paused`, `execution.resumed`, `execution.completed`, `execution.failed`,
`execution.cancelled`, `task.started`, `task.completed`, `task.retrying`, `task.failed`, `task.dead_lettered`.
The payload always carries `eventId` (a UUID), `type`, `aggregateId` (executionId) and `occurredAt`.

## Why a transactional outbox
| Approach | Crash between the two steps | Result |
|---|---|---|
| update MongoDB, then publish | state changed, event never sent | **lost event** |
| publish, then update MongoDB | event sent, state change rolled back | **event for something that didn't happen** |
| **outbox**: event row in the same transaction, relay later | both or neither commit; the relay retries | at-least-once, never lost, never phantom |

`task.started` is the one exception. The claim isn't a transaction, so that single informational event can be lost if
a worker crashes between the claim and the insert. Completion and failure events are always transactional.

## Delivery guarantees (honest)
- **At-least-once.** The relay publishes, then marks rows published. A crash in between republishes the batch. The
  idempotent producer (`idempotent: true`) only dedupes the producer's *own retries within one session*.
- **Ordering:** per execution (same key → same partition → consumer sees them in order). There's no global order.
- **Consumers must be idempotent.** The analytics consumer inserts `(consumer, eventId)` into `processedevents`
  (unique index) **in the same transaction** as its effect. A redelivery hits the duplicate key, the transaction
  aborts, and the effect isn't applied twice. Offsets are committed after processing.
- **Not exactly-once end to end**, and not claimed.

## Relay leadership
Every worker runs a relay runner, but only the holder of the Redis lock `outbox-relay` publishes (Phase 9 lock).
If the leader dies, the lock's TTL frees it and another worker takes over. Two concurrent leaders (a paused leader
past its TTL) would only cause more duplicates, which consumers already tolerate.

## Failure behaviour (tested)
| Scenario | Outcome |
|---|---|
| Kafka down | the relay fails, rows stay unpublished, tasks keep running, and events go out once Kafka is back |
| Relay crashes after publish, before mark | batch republished → consumer skips duplicates (real-Kafka test: 8 messages, 4 applied, 4 skipped) |
| Transaction rolls back | no outbox row, so no event |
| Duplicate completion report | CAS stops the second report, so no second event |
| Unparseable message | logged and skipped (it would otherwise block the partition) |

## Housekeeping
Published rows expire after 7 days (TTL index on `publishedAt`). `processedevents` rows expire after 30 days, so a
redelivery older than that would be counted again (acceptable for analytics).
