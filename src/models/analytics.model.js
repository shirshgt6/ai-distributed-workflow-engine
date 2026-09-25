import mongoose from "mongoose";

// IDEMPOTENT CONSUMER support.
// One row per (consumer, eventId) it has fully processed. The unique index is
// what turns "Kafka may deliver this twice" into "we apply it once".
const processedEventSchema = new mongoose.Schema({
  consumer: { type: String, required: true },
  eventId: { type: String, required: true },
  processedAt: { type: Date, default: Date.now },
});
processedEventSchema.index({ consumer: 1, eventId: 1 }, { unique: true });
processedEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

// Aggregated counts produced by the analytics consumer: events per type per day.
const eventStatSchema = new mongoose.Schema({
  day: { type: String, required: true }, // "YYYY-MM-DD" (UTC)
  type: { type: String, required: true },
  count: { type: Number, default: 0 },
});
eventStatSchema.index({ day: 1, type: 1 }, { unique: true });

export const ProcessedEvent = mongoose.model("ProcessedEvent", processedEventSchema);
export const EventStat = mongoose.model("EventStat", eventStatSchema);
