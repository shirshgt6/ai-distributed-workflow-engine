import mongoose from "mongoose";
import { TASK_STATUS } from "../workflow/states.js";

const { Schema } = mongoose;

// One task INSTANCE inside one execution — a separate document per task,
// not an array inside the execution:
//   - two workers finishing B and C at once update DIFFERENT documents
//     (no contention on one hot document)
//   - recovery can query tasks directly: "RUNNING with an expired lease"
//   - no risk of hitting the 16MB document limit with large outputs
// Cost: changes spanning several tasks need a transaction (replica set: ready).
const taskSchema = new Schema(
  {
    executionId: { type: Schema.Types.ObjectId, ref: "WorkflowExecution", required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    key: { type: String, required: true },
    type: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} },

    // Dependency bookkeeping (used by the engine in Phase 5).
    dependsOn: { type: [String], default: [] }, // parents
    dependents: { type: [String], default: [] }, // children — who to notify on completion
    remainingDeps: { type: Number, required: true }, // parents not yet COMPLETED

    status: { type: String, enum: Object.values(TASK_STATUS), default: TASK_STATUS.PENDING },

    // Retry bookkeeping (Phase 8).
    attempt: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    baseDelayMs: { type: Number, default: 1000 },
    timeoutMs: { type: Number, default: 30_000 },

    // Lease = "worker X may work on this until leaseExpiresAt" (Phases 6-10).
    // leaseToken is a FENCING TOKEN: incremented on every claim, so a late
    // write from an old claim (same worker name, older token) is rejected —
    // the ABA problem Project 1's `lockedBy`-only check could not catch.
    leaseOwner: { type: String, default: null },
    leaseToken: { type: Number, default: 0 },
    leaseExpiresAt: { type: Date, default: null },

    output: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    readyAt: { type: Date, default: null }, // when it became READY (reconciler finds stuck ones)
    retryAt: { type: Date, default: null }, // when a RETRYING task is due (reconciler finds lost wake-ups)
    queuedAt: { type: Date, default: null }, // when it was handed to the executor
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    // Mongoose drops EMPTY objects on save by default (minimize: true), so a
    // handler output like { config: {} } was stored as {} — silently losing
    // a key that downstream tasks might read. Task config/output are user
    // data and must round-trip exactly. (Caught by the Phase 5 e2e test.)
    minimize: false,
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

// One task per key per execution — also makes "create tasks for an
// execution" safe to retry (a duplicate insert fails instead of doubling).
taskSchema.index({ executionId: 1, key: 1 }, { unique: true });
// "all tasks of this execution in state X" (engine, execution status API).
taskSchema.index({ executionId: 1, status: 1 });
// Recovery sweeper: "RUNNING tasks whose lease has expired" (Phase 10).
taskSchema.index({ status: 1, leaseExpiresAt: 1 });
// Reconciler: "READY tasks nobody dispatched" (crash between commit and dispatch).
taskSchema.index({ status: 1, readyAt: 1 });
// Reconciler: "RETRYING tasks whose wake-up was lost".
taskSchema.index({ status: 1, retryAt: 1 });

export const Task = mongoose.model("Task", taskSchema);
