import mongoose from "mongoose";

const { Schema } = mongoose;

export const ATTEMPT_STATUS = Object.freeze({
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
  ABANDONED: "ABANDONED", // worker disappeared (lease expired) — Phase 10
});

// One ATTEMPT of one task. Append-only history: a task retried 3 times has
// 3 of these. Replaces Project 1's ever-growing embedded `history[]` array,
// which made the job document larger with every retry.
const taskExecutionSchema = new Schema(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    executionId: { type: Schema.Types.ObjectId, ref: "WorkflowExecution", required: true },
    attempt: { type: Number, required: true },
    workerId: { type: String, required: true },
    leaseToken: { type: Number, required: true },
    status: { type: String, enum: Object.values(ATTEMPT_STATUS), default: ATTEMPT_STATUS.RUNNING },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    error: {
      message: { type: String },
      retryable: { type: Boolean },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Exactly one record per (task, attempt): recording the same attempt twice
// (e.g. a retried write) fails instead of duplicating history.
taskExecutionSchema.index({ taskId: 1, attempt: 1 }, { unique: true });
taskExecutionSchema.index({ executionId: 1, createdAt: 1 });

export const TaskExecution = mongoose.model("TaskExecution", taskExecutionSchema);
