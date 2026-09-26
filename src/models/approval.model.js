import mongoose from "mongoose";

const { Schema } = mongoose;

// HUMAN-IN-THE-LOOP: one request per waiting task. The PENDING -> decided
// transition is a compare-and-set, so two approvers (or an approver and the
// timeout) can never both win.
const approvalRequestSchema = new Schema(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, unique: true },
    executionId: { type: Schema.Types.ObjectId, ref: "WorkflowExecution", required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true }, // run owner: who may see / decide
    taskKey: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, default: "" },
    context: { type: Schema.Types.Mixed, default: {} }, // what the human needs to decide (e.g. parents' outputs)
    status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"], default: "PENDING" },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    comment: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    minimize: false,
    toJSON: {
      transform(_d, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

approvalRequestSchema.index({ ownerId: 1, status: 1, createdAt: -1 }); // "my pending approvals"
approvalRequestSchema.index({ status: 1, expiresAt: 1 }); // reconciler: overdue ones

export const ApprovalRequest = mongoose.model("ApprovalRequest", approvalRequestSchema);
