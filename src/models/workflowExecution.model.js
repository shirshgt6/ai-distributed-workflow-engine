import mongoose from "mongoose";
import { EXECUTION_STATUS } from "../workflow/states.js";

const { Schema } = mongoose;

// One RUN of a workflow. Created by POST /workflows/:id/run (Phase 5).
const workflowExecutionSchema = new Schema(
  {
    workflowId: { type: Schema.Types.ObjectId, ref: "Workflow", required: true },
    // Denormalised from the workflow so ownership checks on executions don't
    // need a second query (and still work if the workflow is later changed).
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // SNAPSHOT: exactly which version of the definition this run uses.
    workflowVersion: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(EXECUTION_STATUS),
      default: EXECUTION_STATUS.PENDING,
    },
    input: { type: Schema.Types.Mixed, default: {} },

    taskCount: { type: Number, required: true },
    // How many tasks have not finished yet (finished = COMPLETED, FAILED or
    // CANCELLED). Decremented with $inc in the SAME transaction that
    // finishes a task.
    //
    // Why a counter instead of "count unfinished tasks" at the end of each
    // transaction? WRITE SKEW: two last tasks X and Y finishing concurrently
    // each write only their OWN task document, each reads a snapshot where
    // the other is still RUNNING, and neither marks the execution COMPLETED
    // -> stuck RUNNING forever. With the counter, both transactions write
    // THIS document, MongoDB detects the write conflict, one retries with
    // fresh data, sees 0, and completes the execution.
    pendingTasks: { type: Number, required: true },
    triggeredBy: { type: Schema.Types.ObjectId, ref: "User" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    error: { type: String, default: null },
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

// Query patterns:
//   "runs of this workflow, newest first"      -> { workflowId, createdAt }
//   "my runs, newest first"                     -> { ownerId, createdAt }
//   "all RUNNING executions" (recovery/analytics) -> { status }
workflowExecutionSchema.index({ workflowId: 1, createdAt: -1 });
workflowExecutionSchema.index({ ownerId: 1, createdAt: -1 });
workflowExecutionSchema.index({ status: 1 });

export const WorkflowExecution = mongoose.model("WorkflowExecution", workflowExecutionSchema);
