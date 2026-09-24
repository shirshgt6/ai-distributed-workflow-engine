import { ownerScope } from "../auth/ownership.js";
import { NotFoundError } from "../utils/errors.js";

/**
 * HTTP-facing operations on executions. Ownership is enforced here (in the
 * query, as for workflows); the engine itself knows nothing about users.
 *
 * @param {{ Workflow, WorkflowExecution, Task, engine: ReturnType<import('../workflow/engine.js').createEngine> }} deps
 */
export function createExecutionService({ Workflow, WorkflowExecution, Task, engine }) {
  return {
    async run(user, workflowId, input) {
      const workflow = await Workflow.findOne({ _id: workflowId, ...ownerScope(user) });
      if (!workflow) throw new NotFoundError("Workflow not found");
      return engine.startExecution({ workflow, input, triggeredBy: user.id });
    },

    async get(user, executionId) {
      const execution = await WorkflowExecution.findOne({ _id: executionId, ...ownerScope(user) });
      if (!execution) throw new NotFoundError("Execution not found");
      const tasks = await Task.find({ executionId: execution._id })
        .select("key type status dependsOn attempt output error readyAt startedAt completedAt")
        .sort({ _id: 1 });
      return { execution, tasks };
    },
  };
}
