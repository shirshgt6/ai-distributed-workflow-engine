import { createHash } from "node:crypto";
import { ownerScope } from "../auth/ownership.js";
import { AppError, NotFoundError } from "../utils/errors.js";

const DUPLICATE_KEY = 11000;

/** JSON with object keys sorted, so {a,b} and {b,a} hash the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * HTTP-facing operations on executions. Ownership is enforced here (in the
 * query, as for workflows); the engine itself knows nothing about users.
 *
 * @param {{ Workflow, WorkflowExecution, Task, engine: ReturnType<import('../workflow/engine.js').createEngine> }} deps
 */
export function createExecutionService({ Workflow, WorkflowExecution, Task, engine }) {
  return {
    /**
     * Start a run. With an idempotency key, retrying the SAME request (double
     * click, network retry after a timeout) returns the run that was already
     * created instead of starting a second one.
     *
     * @returns {Promise<{ execution, replayed: boolean }>}
     */
    async run(user, workflowId, input, { idempotencyKey } = {}) {
      const workflow = await Workflow.findOne({ _id: workflowId, ...ownerScope(user) });
      if (!workflow) throw new NotFoundError("Workflow not found");

      const requestHash = idempotencyKey
        ? createHash("sha256").update(canonical({ workflowId: String(workflowId), input })).digest("hex")
        : undefined;

      try {
        const execution = await engine.startExecution({
          workflow,
          input,
          triggeredBy: user.id,
          idempotencyKey,
          requestHash,
        });
        return { execution, replayed: false };
      } catch (err) {
        const isKeyClash = idempotencyKey && err?.code === DUPLICATE_KEY && err?.keyPattern?.idempotencyKey;
        if (!isKeyClash) throw err;

        // The unique index said "this key was already used by this user".
        const existing = await WorkflowExecution.findOne({ triggeredBy: user.id, idempotencyKey });
        if (existing.requestHash !== requestHash) {
          // Same key, DIFFERENT request: almost certainly a client bug.
          // Replaying the old response would silently hide it.
          throw new AppError("Idempotency-Key was already used with a different request", {
            statusCode: 422,
            code: "IDEMPOTENCY_KEY_REUSED",
          });
        }
        return { execution: existing, replayed: true };
      }
    },

    /** pause | resume | cancel an execution the user owns. */
    async control(user, executionId, action) {
      const execution = await WorkflowExecution.findOne({ _id: executionId, ...ownerScope(user) }).select("_id status");
      if (!execution) throw new NotFoundError("Execution not found");
      const op = { pause: engine.pauseExecution, resume: engine.resumeExecution, cancel: engine.cancelExecution }[action];
      const changed = await op(execution._id);
      if (!changed) {
        throw new AppError(`Cannot ${action} an execution that is ${execution.status}`, {
          statusCode: 409,
          code: "INVALID_STATE",
          details: { status: execution.status },
        });
      }
      return WorkflowExecution.findById(execution._id);
    },

    async get(user, executionId) {
      const execution = await WorkflowExecution.findOne({ _id: executionId, ...ownerScope(user) });
      if (!execution) throw new NotFoundError("Execution not found");
      const tasks = await Task.find({ executionId: execution._id })
        .select("key type status dependsOn attempt maxAttempts output error readyAt retryAt startedAt completedAt")
        .sort({ _id: 1 });
      return { execution, tasks };
    },
  };
}
