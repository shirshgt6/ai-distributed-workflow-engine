import mongoose from "mongoose";
import { validateDag } from "./dag.js";
import { assertTransition, EXECUTION_STATUS as E, TASK_STATUS as T } from "./states.js";
import { claimQueuedTask, transitionTask } from "../repositories/task.repository.js";
import { ATTEMPT_STATUS } from "../models/taskExecution.model.js";
import { ValidationError } from "../utils/errors.js";

/**
 * THE WORKFLOW ENGINE — dependency resolution and orchestration.
 *
 * There is no central orchestrator process holding state in memory. The
 * engine is a set of functions, and all state lives in MongoDB (the
 * "whiteboard"). Whoever finishes a task runs completeTask(), which works out
 * what became ready. Any process can call any function; correctness comes
 * from transactions + conditional updates, not from being the only caller.
 *
 *   startExecution ──► dispatch READY ──► (executor) startTask ──► handler
 *        ▲                                                             │
 *        └──────────── dispatch newly READY ◄── completeTask / failTask ◄┘
 *
 * The engine never runs task code itself. `enqueue` hands a task to whatever
 * executes it (in-process executor now; Redis queue + workers from Phase 6).
 *
 * @param {{
 *   models: { WorkflowExecution, Task, TaskExecution },
 *   enqueue: (item: { taskId: string, executionId: string, key: string }) => void | Promise<void>,
 *   logger: import('pino').Logger,
 *   connection?: import('mongoose').Connection,
 * }} deps
 */
export function createEngine({ models, enqueue, logger, connection = mongoose.connection }) {
  const { WorkflowExecution, Task, TaskExecution } = models;

  const now = () => new Date();

  /**
   * Hand every READY task of an execution to the executor.
   *
   * READY -> QUEUED is a compare-and-set, so calling this twice (or from two
   * processes, or from the reconciler at the same time) never enqueues the
   * same task twice: only the caller whose transition succeeded enqueues it.
   */
  async function dispatchReady(executionId) {
    const ready = await Task.find({ executionId, status: T.READY }).select("_id key executionId");
    for (const task of ready) {
      await dispatchTask(task);
    }
  }

  async function dispatchTask(task) {
    const won = await transitionTask(task._id, T.READY, T.QUEUED, { set: { queuedAt: now() } });
    if (!won) return false;
    await enqueue({ taskId: String(task._id), executionId: String(task.executionId), key: task.key });
    logger.debug({ executionId: String(task.executionId), taskKey: task.key }, "task dispatched");
    return true;
  }

  return {
    dispatchReady,

    /**
     * Start a run of a workflow definition.
     *
     * ONE transaction creates the execution AND all its task documents:
     * either the whole run exists or none of it does. A crash halfway can't
     * leave an execution whose tasks are partly missing (a "zombie" run that
     * could never finish).
     *
     * Dispatching happens AFTER the commit. If we crash between commit and
     * dispatch, the READY tasks are still on the whiteboard and the
     * reconciler (reconcileStuckReady) will dispatch them.
     *
     * @param {{ workflow: object, input?: object, triggeredBy?: string }} params
     */
    async startExecution({ workflow, input = {}, triggeredBy }) {
      // Defence in depth: definitions saved before graph validation existed
      // (Phase 3) could be invalid. Never start a run that can't finish.
      const check = validateDag(workflow.tasks);
      if (!check.valid) {
        throw new ValidationError("Workflow task graph is invalid", {
          code: "INVALID_WORKFLOW_GRAPH",
          details: check.errors,
        });
      }

      // children lists: who to notify when a task completes.
      const dependents = new Map(workflow.tasks.map((t) => [t.key, []]));
      for (const t of workflow.tasks) {
        for (const dep of t.dependsOn) dependents.get(dep).push(t.key);
      }

      let execution;
      await connection.transaction(async (session) => {
        const startedAt = now();
        [execution] = await WorkflowExecution.create(
          [
            {
              workflowId: workflow._id,
              // The run belongs to the workflow's owner (so they can see it)
              // even when an admin triggered it; triggeredBy records who did.
              ownerId: workflow.ownerId,
              workflowVersion: workflow.version,
              status: E.RUNNING,
              input,
              triggeredBy,
              startedAt,
              taskCount: workflow.tasks.length,
              pendingTasks: workflow.tasks.length,
            },
          ],
          { session }
        );

        // Each Task copies type/config/retry settings from the definition:
        // this copy IS the snapshot. Editing the workflow later can't change it.
        const tasks = workflow.tasks.map((def) => {
          const isRoot = def.dependsOn.length === 0;
          return {
            executionId: execution._id,
            ownerId: workflow.ownerId,
            key: def.key,
            type: def.type,
            config: def.config,
            dependsOn: def.dependsOn,
            dependents: dependents.get(def.key),
            remainingDeps: def.dependsOn.length,
            status: isRoot ? T.READY : T.PENDING,
            readyAt: isRoot ? startedAt : null,
            maxAttempts: def.retryPolicy?.maxAttempts,
            baseDelayMs: def.retryPolicy?.baseDelayMs,
            timeoutMs: def.timeoutMs,
          };
        });
        await Task.insertMany(tasks, { session });
      });

      logger.info(
        { executionId: String(execution._id), workflowId: String(workflow._id), taskCount: workflow.tasks.length },
        "execution started"
      );
      await dispatchReady(execution._id);
      return execution;
    },

    /**
     * Executor picks up a task: QUEUED -> RUNNING (+ attempt, + fencing token),
     * records the attempt, and gathers the handler's inputs.
     *
     * @returns {Promise<null | { task, input, parents }>} null = skip (cancelled or claimed elsewhere)
     */
    async startTask(taskId, workerId) {
      const task = await claimQueuedTask(taskId, workerId);
      if (!task) return null;

      // Not in the claim transaction on purpose (Phase 5 keeps claim cheap).
      // If we crash right here the task is RUNNING without an attempt record;
      // lease-based recovery (Phase 10) covers orphaned RUNNING tasks.
      await TaskExecution.create({
        taskId: task._id,
        executionId: task.executionId,
        attempt: task.attempt,
        workerId,
        leaseToken: task.leaseToken,
      });

      // Data flow along the DAG: each handler receives its parents' outputs.
      const [execution, parents] = await Promise.all([
        WorkflowExecution.findById(task.executionId).select("input"),
        Task.find({ executionId: task.executionId, key: { $in: task.dependsOn } }).select("key output"),
      ]);

      return {
        task,
        input: execution?.input ?? {},
        parents: Object.fromEntries(parents.map((p) => [p.key, p.output])),
      };
    },

    /**
     * A task finished successfully. ONE transaction:
     *   1. RUNNING -> COMPLETED, only for the current lease (CAS + fencing).
     *      A duplicate or stale report matches nothing -> no-op. This is what
     *      makes the whole function safe to call twice (idempotent).
     *   2. execution.pendingTasks - 1   (every completion writes the execution
     *      doc -> concurrent completions conflict -> no write skew)
     *   3. children: remainingDeps - 1; those at 0 go PENDING -> READY
     *      (only if the execution is still RUNNING — after a failure, nothing
     *      new is started)
     *   4. pendingTasks reached 0 -> execution RUNNING -> COMPLETED
     * After commit: dispatch whatever became READY.
     *
     * If two siblings (B, C) complete at once, both transactions write the
     * same child (D) and the same execution document. MongoDB aborts one
     * with a write conflict; connection.transaction() retries it against
     * fresh data. So D is promoted exactly once.
     *
     * @returns {Promise<{ applied: boolean }>}
     */
    async completeTask({ taskId, leaseToken, output = null }) {
      let applied = false;
      let executionId;

      await connection.transaction(async (session) => {
        applied = false; // the callback may be retried: reset per attempt
        const finishedAt = now();

        const won = await transitionTask(taskId, T.RUNNING, T.COMPLETED, {
          where: { leaseToken },
          set: { output, completedAt: finishedAt, leaseOwner: null, leaseExpiresAt: null },
          session,
        });
        if (!won) return;

        const task = await Task.findById(taskId, null, { session });
        executionId = task.executionId;

        await TaskExecution.updateOne(
          { taskId, attempt: task.attempt },
          {
            $set: {
              status: ATTEMPT_STATUS.SUCCEEDED,
              finishedAt,
              durationMs: task.startedAt ? finishedAt - task.startedAt : null,
            },
          },
          { session }
        );

        const execution = await WorkflowExecution.findOneAndUpdate(
          { _id: task.executionId },
          { $inc: { pendingTasks: -1 } },
          { returnDocument: "after", session }
        );

        if (execution.status === E.RUNNING && task.dependents.length > 0) {
          await Task.updateMany(
            { executionId: task.executionId, key: { $in: task.dependents } },
            { $inc: { remainingDeps: -1 } },
            { session }
          );
          assertTransition("task", T.PENDING, T.READY);
          await Task.updateMany(
            { executionId: task.executionId, key: { $in: task.dependents }, status: T.PENDING, remainingDeps: 0 },
            { $set: { status: T.READY, readyAt: finishedAt } },
            { session }
          );
        }

        if (execution.status === E.RUNNING && execution.pendingTasks === 0) {
          assertTransition("execution", E.RUNNING, E.COMPLETED);
          await WorkflowExecution.updateOne(
            { _id: execution._id, status: E.RUNNING },
            { $set: { status: E.COMPLETED, completedAt: finishedAt } },
            { session }
          );
          logger.info({ executionId: String(execution._id) }, "execution completed");
        }

        applied = true;
      });

      if (applied) await dispatchReady(executionId);
      return { applied };
    },

    /**
     * A task failed. Phase 5 policy: FAIL-FAST, no retries yet (Phase 8).
     * ONE transaction:
     *   1. RUNNING -> FAILED (CAS + fencing; duplicate/stale = no-op)
     *   2. if the execution is still RUNNING:
     *        - every task that has NOT started (PENDING / READY / QUEUED)
     *          -> CANCELLED: they can never all be satisfied now
     *        - execution RUNNING -> FAILED
     *      Tasks already RUNNING are left to finish; their results are
     *      recorded, but completeTask won't start anything new because the
     *      execution is no longer RUNNING.
     *
     * @returns {Promise<{ applied: boolean }>}
     */
    async failTask({ taskId, leaseToken, error }) {
      const message = String(error?.message ?? error ?? "Task failed").slice(0, 2000);
      let applied = false;

      await connection.transaction(async (session) => {
        applied = false;
        const finishedAt = now();

        const won = await transitionTask(taskId, T.RUNNING, T.FAILED, {
          where: { leaseToken },
          set: { error: message, completedAt: finishedAt, leaseOwner: null, leaseExpiresAt: null },
          session,
        });
        if (!won) return;

        const task = await Task.findById(taskId, null, { session });

        await TaskExecution.updateOne(
          { taskId, attempt: task.attempt },
          {
            $set: {
              status: error?.name === "TimeoutError" ? ATTEMPT_STATUS.TIMED_OUT : ATTEMPT_STATUS.FAILED,
              finishedAt,
              durationMs: task.startedAt ? finishedAt - task.startedAt : null,
              error: { message, retryable: false },
            },
          },
          { session }
        );

        const execution = await WorkflowExecution.findOneAndUpdate(
          { _id: task.executionId },
          { $inc: { pendingTasks: -1 } },
          { returnDocument: "after", session }
        );

        if (execution.status === E.RUNNING) {
          const cancelled = await Task.updateMany(
            { executionId: task.executionId, status: { $in: [T.PENDING, T.READY, T.QUEUED] } },
            { $set: { status: T.CANCELLED, completedAt: finishedAt } },
            { session }
          );
          assertTransition("execution", E.RUNNING, E.FAILED);
          await WorkflowExecution.updateOne(
            { _id: execution._id, status: E.RUNNING },
            {
              $set: { status: E.FAILED, error: `Task "${task.key}" failed: ${message}`, completedAt: finishedAt },
              $inc: { pendingTasks: -cancelled.modifiedCount },
            },
            { session }
          );
          logger.warn(
            { executionId: String(execution._id), taskKey: task.key, cancelled: cancelled.modifiedCount },
            "execution failed (fail-fast)"
          );
        }

        applied = true;
      });

      return { applied };
    },

    /**
     * RECONCILER: find READY tasks that nobody dispatched and dispatch them.
     *
     * How a task gets stuck READY: a transaction committed "D is READY", then
     * the process crashed before calling dispatch. Memory forgot; the
     * whiteboard didn't. Only tasks READY for longer than `staleMs` are
     * touched — a freshly READY task is about to be dispatched normally.
     * Safe to run concurrently with normal dispatch: READY -> QUEUED is a CAS.
     *
     * @returns {Promise<number>} how many tasks this call dispatched
     */
    async reconcileStuckReady({ staleMs, limit = 100 }) {
      const cutoff = new Date(Date.now() - staleMs);
      const stuck = await Task.find({ status: T.READY, readyAt: { $lt: cutoff } })
        .select("_id key executionId")
        .limit(limit);
      let dispatched = 0;
      for (const task of stuck) {
        if (await dispatchTask(task)) dispatched += 1;
      }
      if (dispatched > 0) logger.warn({ dispatched }, "reconciler dispatched stuck READY tasks");
      return dispatched;
    },

    /**
     * SINGLE-PROCESS MODE ONLY (Phase 5). The in-process executor's queue
     * lives in memory, so after a restart every QUEUED or RUNNING task is an
     * orphan: nothing will ever run or finish it. Move them back to READY /
     * QUEUED and dispatch again.
     *
     * This is only correct while exactly ONE process executes tasks. With
     * multiple workers (Phase 7) a RUNNING task may belong to a healthy
     * worker elsewhere — Phase 10 replaces this with lease expiry.
     *
     * @returns {Promise<number>} tasks recovered
     */
    async recoverInProcessOrphans() {
      // RUNNING -> QUEUED ("worker died"). Bumping leaseToken fences off any
      // late report from the dead attempt.
      assertTransition("task", T.RUNNING, T.QUEUED);
      const running = await Task.updateMany(
        { status: T.RUNNING },
        { $set: { status: T.QUEUED, leaseOwner: null, queuedAt: now() }, $inc: { leaseToken: 1 } }
      );
      // QUEUED -> READY, then dispatch through the normal CAS path.
      assertTransition("task", T.QUEUED, T.READY);
      const orphans = await Task.find({ status: T.QUEUED }).select("_id executionId");
      await Task.updateMany({ _id: { $in: orphans.map((t) => t._id) }, status: T.QUEUED }, { $set: { status: T.READY } });
      const executionIds = [...new Set(orphans.map((t) => String(t.executionId)))];
      for (const id of executionIds) await dispatchReady(id);

      const recovered = orphans.length;
      if (recovered > 0) {
        logger.warn({ recovered, wereRunning: running.modifiedCount }, "recovered orphaned tasks after restart");
      }
      return recovered;
    },
  };
}
