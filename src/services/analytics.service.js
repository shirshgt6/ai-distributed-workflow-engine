import mongoose from "mongoose";
import { ROLES } from "../auth/permissions.js";

/**
 * Analytics = MongoDB aggregations over what the system already records
 * (executions, tasks, attempts, AI calls). Scoped to the user's own data;
 * admins see everything.
 */
export function createAnalyticsService({ WorkflowExecution, Task, TaskExecution, AIExecution }) {
  const scope = (user) => (user.role === ROLES.ADMIN ? {} : { ownerId: new mongoose.Types.ObjectId(user.id) });
  const since = (from) => ({ createdAt: { $gte: from } });

  return {
    /** Per model: calls, errors, fallbacks, latency (avg, p95), tokens, cost. */
    async ai(user, { from }) {
      const byModel = await AIExecution.aggregate([
        { $match: { ...scope(user), ...since(from) } },
        {
          $group: {
            _id: { provider: "$provider", model: "$model", operation: "$operation" },
            calls: { $sum: 1 },
            errors: { $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] } },
            fallbacks: { $sum: { $cond: ["$fallbackUsed", 1, 0] } },
            avgLatencyMs: { $avg: "$latencyMs" },
            p95LatencyMs: { $percentile: { input: "$latencyMs", p: [0.95], method: "approximate" } },
            inputTokens: { $sum: "$inputTokens" },
            outputTokens: { $sum: "$outputTokens" },
            estimatedCostUsd: { $sum: "$estimatedCostUsd" },
          },
        },
        { $sort: { calls: -1 } },
      ]);
      const models = byModel.map((m) => ({
        ...m._id,
        calls: m.calls,
        errors: m.errors,
        errorRate: Number((m.errors / m.calls).toFixed(4)),
        fallbacks: m.fallbacks,
        avgLatencyMs: Math.round(m.avgLatencyMs ?? 0),
        p95LatencyMs: Math.round(m.p95LatencyMs?.[0] ?? 0),
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        totalTokens: m.inputTokens + m.outputTokens,
        estimatedCostUsd: Number(m.estimatedCostUsd.toFixed(6)),
      }));
      const totals = models.reduce(
        (t, m) => ({
          calls: t.calls + m.calls,
          errors: t.errors + m.errors,
          fallbacks: t.fallbacks + m.fallbacks,
          totalTokens: t.totalTokens + m.totalTokens,
          estimatedCostUsd: Number((t.estimatedCostUsd + m.estimatedCostUsd).toFixed(6)),
        }),
        { calls: 0, errors: 0, fallbacks: 0, totalTokens: 0, estimatedCostUsd: 0 }
      );
      const byTaskType = await AIExecution.aggregate([
        { $match: { ...scope(user), ...since(from), taskType: { $ne: null } } },
        { $group: { _id: "$taskType", calls: { $sum: 1 }, totalTokens: { $sum: "$totalTokens" } } },
        { $sort: { calls: -1 } },
      ]);
      return { from, totals, models, byTaskType: byTaskType.map((t) => ({ taskType: t._id, calls: t.calls, totalTokens: t.totalTokens })) };
    },

    /** Runs by status, success rate, duration, retries, what fails most. */
    async workflows(user, { from }) {
      const match = { ...scope(user), ...since(from) };
      const [byStatus, durations] = await Promise.all([
        WorkflowExecution.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        WorkflowExecution.aggregate([
          { $match: { ...match, status: "COMPLETED", completedAt: { $ne: null } } },
          { $project: { ms: { $subtract: ["$completedAt", "$startedAt"] } } },
          {
            $group: {
              _id: null,
              avg: { $avg: "$ms" },
              p95: { $percentile: { input: "$ms", p: [0.95], method: "approximate" } },
            },
          },
        ]),
      ]);
      const counts = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));
      const finished = (counts.COMPLETED ?? 0) + (counts.FAILED ?? 0);

      const executionIds = (await WorkflowExecution.find(match).select("_id").lean()).map((e) => e._id);
      const [failingTaskTypes, attempts] = await Promise.all([
        Task.aggregate([
          { $match: { executionId: { $in: executionIds }, status: { $in: ["FAILED", "DEAD_LETTER"] } } },
          { $group: { _id: "$type", failures: { $sum: 1 } } },
          { $sort: { failures: -1 } },
          { $limit: 5 },
        ]),
        TaskExecution.aggregate([
          { $match: { executionId: { $in: executionIds } } },
          {
            $group: {
              _id: null,
              attempts: { $sum: 1 },
              retries: { $sum: { $cond: [{ $gt: ["$attempt", 1] }, 1, 0] } },
              abandoned: { $sum: { $cond: [{ $eq: ["$status", "ABANDONED"] }, 1, 0] } },
            },
          },
        ]),
      ]);

      return {
        from,
        executions: { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts },
        successRate: finished ? Number(((counts.COMPLETED ?? 0) / finished).toFixed(4)) : null,
        durationMs: { avg: Math.round(durations[0]?.avg ?? 0), p95: Math.round(durations[0]?.p95?.[0] ?? 0) },
        attempts: { total: attempts[0]?.attempts ?? 0, retries: attempts[0]?.retries ?? 0, abandonedByCrashedWorkers: attempts[0]?.abandoned ?? 0 },
        topFailingTaskTypes: failingTaskTypes.map((f) => ({ type: f._id, failures: f.failures })),
      };
    },
  };
}
