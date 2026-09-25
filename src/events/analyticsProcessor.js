import mongoose from "mongoose";

const DUPLICATE_KEY = 11000;

/**
 * IDEMPOTENT CONSUMER logic for the analytics consumer group.
 *
 * In ONE MongoDB transaction:
 *   1. insert (consumer, eventId) into processedevents  (unique index)
 *   2. apply the effect: count the event per type per day
 * A redelivered event fails step 1 with a duplicate-key error, the whole
 * transaction aborts, and the effect is not applied twice. Because the
 * marker and the effect commit together, a crash can't leave "counted but
 * not marked" or "marked but not counted".
 *
 * @returns {{ process(event): Promise<"applied"|"duplicate"> }}
 */
export function createAnalyticsProcessor({ ProcessedEvent, EventStat, consumer = "analytics", connection = mongoose.connection }) {
  return {
    async process(event) {
      const day = new Date(event.occurredAt ?? Date.now()).toISOString().slice(0, 10);
      try {
        await connection.transaction(async (session) => {
          await ProcessedEvent.create([{ consumer, eventId: event.eventId }], { session });
          await EventStat.updateOne({ day, type: event.type }, { $inc: { count: 1 } }, { upsert: true, session });
        });
        return "applied";
      } catch (err) {
        if (err?.code === DUPLICATE_KEY && err?.keyPattern?.eventId) return "duplicate";
        throw err;
      }
    },
  };
}
