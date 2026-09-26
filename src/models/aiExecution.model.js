import mongoose from "mongoose";

const { Schema } = mongoose;

// One row per LLM call (chat or embed). No prompt or response TEXT is stored:
// they can contain user data, and metrics don't need them.
const aiExecutionSchema = new Schema(
  {
    operation: { type: String, enum: ["chat", "embed"], required: true },
    executionId: { type: Schema.Types.ObjectId, default: null },
    taskId: { type: Schema.Types.ObjectId, default: null },
    ownerId: { type: Schema.Types.ObjectId, default: null },
    taskType: { type: String, default: null }, // e.g. "ai.rag"
    provider: String,
    model: String,
    status: { type: String, enum: ["success", "error"], required: true },
    error: { type: String, default: null },
    retryable: { type: Boolean, default: null },
    fallbackUsed: { type: Boolean, default: false },
    latencyMs: Number,
    inputTokens: Number,
    outputTokens: Number,
    totalTokens: Number,
    estimatedCostUsd: Number,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

aiExecutionSchema.index({ ownerId: 1, createdAt: -1 });
aiExecutionSchema.index({ model: 1, createdAt: -1 });
aiExecutionSchema.index({ executionId: 1 });
// Keep 90 days of call-level history.
aiExecutionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export const AIExecution = mongoose.model("AIExecution", aiExecutionSchema);
