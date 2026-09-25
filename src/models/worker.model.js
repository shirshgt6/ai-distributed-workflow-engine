import mongoose from "mongoose";

// WORKER REGISTRY: one document per worker process, refreshed by its
// heartbeat. Used for visibility (GET /workers), not for correctness: task
// recovery never depends on this collection, only on task leases. A worker
// whose lastSeenAt is older than a few heartbeat intervals is presumed dead.
const workerSchema = new mongoose.Schema(
  {
    workerId: { type: String, required: true, unique: true },
    host: String,
    pid: Number,
    concurrency: Number,
    status: { type: String, enum: ["ACTIVE", "STOPPED"], default: "ACTIVE" },
    runningTasks: { type: Number, default: 0 },
    tasksCompleted: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

workerSchema.index({ lastSeenAt: -1 });

export const Worker = mongoose.model("Worker", workerSchema);
