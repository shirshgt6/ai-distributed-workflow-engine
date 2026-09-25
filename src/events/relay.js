/**
 * OUTBOX RELAY: moves committed events from MongoDB to Kafka.
 *
 *   read oldest unpublished rows -> publish to Kafka -> mark them published
 *
 * Crash after publish, before marking -> the same rows are published again on
 * the next run. That duplicate is the accepted price of never LOSING an
 * event: at-least-once. Consumers dedupe by eventId.
 *
 * Only ONE relay should run at a time (several would publish the same rows
 * concurrently: more duplicates, scrambled order). createRelayRunner uses the
 * Redis lock from Phase 9 as a leader election for that.
 *
 * @param {{ OutboxEvent, publish: (messages: object[]) => Promise<void>, logger, batchSize?: number }} deps
 */
export function createOutboxRelay({ OutboxEvent, publish, logger, batchSize = 100 }) {
  return {
    /** @returns {Promise<number>} how many events were published */
    async relayOnce() {
      const batch = await OutboxEvent.find({ publishedAt: null }).sort({ _id: 1 }).limit(batchSize).lean();
      if (batch.length === 0) return 0;

      await publish(
        batch.map((e) => ({
          // Key = executionId: all events of one run go to the same partition,
          // so a consumer sees them in order.
          key: e.aggregateId,
          value: JSON.stringify({
            eventId: e.eventId,
            type: e.type,
            aggregateId: e.aggregateId,
            occurredAt: e.occurredAt,
            payload: e.payload,
          }),
          headers: { eventId: e.eventId, type: e.type },
        }))
      );

      await OutboxEvent.updateMany({ _id: { $in: batch.map((e) => e._id) } }, { $set: { publishedAt: new Date() } });
      logger.debug({ count: batch.length }, "outbox events published");
      return batch.length;
    },
  };
}

/**
 * Runs the relay on an interval, but only while holding the "outbox-relay"
 * lock. Every worker process starts one of these; exactly one of them
 * actually relays at any moment. If the leader dies, its lock expires and
 * another worker takes over.
 *
 * @param {{ relay, lock: ReturnType<import('../queues/lock.js').createLock>, intervalMs: number, logger }} deps
 */
export function createRelayRunner({ relay, lock, intervalMs, logger }) {
  let timer = null;
  let held = null;
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (held && !(await lock.extend(held.token))) {
        logger.warn("lost outbox relay leadership");
        held = null;
      }
      if (!held) {
        held = await lock.acquire();
        if (held) logger.info({ fence: held.fence }, "became outbox relay leader");
      }
      if (!held) return;
      // Drain in batches until empty (bounded per tick).
      for (let i = 0; i < 20; i++) {
        if ((await relay.relayOnce()) === 0) break;
      }
    } catch (err) {
      logger.warn({ err: err.message }, "outbox relay tick failed (will retry)");
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      timer = setInterval(tick, intervalMs);
    },
    async stop() {
      clearInterval(timer);
      if (held) await lock.release(held.token).catch(() => {});
      held = null;
    },
    tick, // exposed for tests
  };
}
