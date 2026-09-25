import mongoose from "mongoose";

// TRANSACTIONAL OUTBOX.
//
// Problem: "update MongoDB, then publish to Kafka" is two systems. Crash
// between them -> state changed but the event is lost forever. Publish first
// -> an event for a change that then rolled back.
//
// Fix: write the event as a row in THIS collection inside the SAME MongoDB
// transaction as the state change. Both commit or neither does. A separate
// relay later reads unpublished rows and sends them to Kafka.
//
// Cost: an event can be published MORE than once (relay crashes after send,
// before marking the row published). So delivery is at-least-once and every
// consumer must deduplicate by eventId.
const outboxEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true }, // consumers dedupe on this
    type: { type: String, required: true }, // e.g. "task.completed"
    aggregateId: { type: String, required: true }, // executionId -> Kafka message key
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: Date.now },
    publishedAt: { type: Date, default: null },
  },
  { minimize: false }
);

// Relay query: oldest unpublished first.
outboxEventSchema.index({ publishedAt: 1, _id: 1 });
// Housekeeping: published rows expire after 7 days (unpublished rows have
// publishedAt = null and are never removed by the TTL monitor).
outboxEventSchema.index({ publishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600, name: "published_ttl" });

export const OutboxEvent = mongoose.model("OutboxEvent", outboxEventSchema);
