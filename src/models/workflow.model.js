import mongoose from "mongoose";

const { Schema } = mongoose;

// One task DEFINITION inside a workflow (the "recipe step").
// Runtime state (status, attempts, output) does NOT live here — that is the
// Task model, one per execution.
const taskDefinitionSchema = new Schema(
  {
    key: { type: String, required: true }, // unique within the workflow; used by dependsOn
    name: { type: String },
    type: { type: String, required: true }, // which handler runs it, e.g. "http.request", "ai.classify"
    dependsOn: { type: [String], default: [] }, // keys of tasks that must COMPLETE first
    config: { type: Schema.Types.Mixed, default: {} }, // handler-specific input
    retryPolicy: {
      maxAttempts: { type: Number, default: 3 },
      baseDelayMs: { type: Number, default: 1000 },
    },
    timeoutMs: { type: Number, default: 30_000 },
  },
  { _id: false }
);

const workflowSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    tasks: { type: [taskDefinitionSchema], required: true },

    // OPTIMISTIC CONCURRENCY. Every edit must say which version it was based
    // on; the update only applies if that is still the current version, and
    // bumps it. Two people editing the same v3 -> one wins, the other gets
    // 409 instead of silently overwriting (lost update).
    //
    // Executions copy `tasks` + `version` when they start (snapshot), so
    // editing a workflow never changes a run that is already in progress.
    version: { type: Number, default: 1 },
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

// Query pattern: "my workflows, newest first" (GET /workflows).
workflowSchema.index({ ownerId: 1, createdAt: -1 });

export const Workflow = mongoose.model("Workflow", workflowSchema);
