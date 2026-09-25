import mongoose from "mongoose";
import { validateDag } from "./dag.js";
import { assertTransition, EXECUTION_STATUS as E, TASK_STATUS as T } from "./states.js";
import { claimTask, transitionTask } from "../repositories/task.repository.js";
import { ATTEMPT_STATUS } from "../models/taskExecution.model.js";
import { ValidationError } from "../utils/errors.js";
import { computeBackoff, isRetryable } from "../workers/retry.js";

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
 * The engine never runs task code itself. `enqueue` hands a task id to the
 * Redis queue (src/queues/taskQueue.js); workers pull from there.
 *
 * @param {{
 *   models: { WorkflowExecution, Task, TaskExecution },
 *   enqueue: (item: { taskId: string, executionId: string, key: string }) => void | Promise<void>,
 *   enqueueDelayed?: (item: { taskId: string }, delayMs: number) => void | Promise<void>,
 *   logger: import('pino').Logger,
 *   leaseGraceMs?: number,
 *   backoff?: (attempt: number, baseDelayMs: number) => number,
 *   connection?: import('mongoose').Connection,
 * }} deps
 *   leaseGraceMs: extra time on top of a task's timeoutMs before its lease
 *   expires and another worker may take it over.
 */
export function createEngine({
  models,
  enqueue,
  enqueueDelayed,
  logger,
  leaseGraceMs = 10_000,
  backoff = computeBackoff,
  connection = mongoose.connection,
}) {
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
    await enqueueSafely(task);
    logger.debug({ executionId: String(task.executionId), taskKey: task.key }, "task dispatched");
    return true;
  }

  /**
   * MongoDB already says QUEUED (committed). If Redis is down right now, do
   * NOT fail the caller: the run really did start, and a 500 would make the
   * client retry and start a second run. The reconciler re-enqueues stale
   * QUEUED tasks once Redis is back. Enqueue is idempotent, so that's safe.
   */
  async function enqueueSafely(task) {
    try {
      await enqueue({ taskId: String(task._id), executionId: String(task.executionId), key: task.key });
      return true;
    } catch (err) {
      logger.warn(
        { taskId: String(task._id), err: err.message },
        "enqueue failed; task stays QUEUED in MongoDB and the reconciler will retry"
      );
      return false;
    }
  }

  /** Same idea for retries: RETRYING is committed; Redis only schedules the wake-up. */
  async function enqueueRetrySafely(task, delayMs) {
    try {
      if (enqueueDelayed) await enqueueDelayed({ taskId: String(task._id) }, delayMs);
      else await enqueue({ taskId: String(task._id), executionId: String(task.executionId), key: task.key });
    } catch (err) {
      logger.warn({ taskId: String(task._id), err: err.message }, "scheduling retry failed; the reconciler will retry");
    }
  }

  const engine = {
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
     * reconciler (reconcile) will dispatch them.
     *
     * @param {{ workflow: object, input?: object, triggeredBy?: string, idempotencyKey?: string, requestHash?: string }} params
     *   A duplicate idempotencyKey (same triggeredBy) makes the insert fail
     *   with a duplicate-key error (code 11000); the caller decides how to reply.
     */
    async startExecution({ workflow, input = {}, triggeredBy, idempotencyKey, requestHash }) {
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
              idempotencyKey,
              requestHash,
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
     * A worker picks up a task: -> RUNNING (+ attempt, + fencing token, + lease),
     * records the attempt, and gathers the handler's inputs.
     *
     * @returns {Promise<null | { task, input, parents }>} null = skip
     *   (finished, cancelled, or running elsewhere under a live lease)
     */
    async startTask(taskId, workerId) {
      const task = await claimTask(taskId, workerId, { leaseGraceMs });
      if (!task) return null;

      // If this was a TAKEOVER, the previous attempt's record is still RUNNING:
      // its worker vanished. Close it as ABANDONED so history is truthful.
      await TaskExecution.updateMany(
        { taskId: task._id, attempt: { $lt: task.attempt }, status: ATTEMPT_STATUS.RUNNING },
        { $set: { status: ATTEMPT_STATUS.ABANDONED, finishedAt: now() } }
      );

      // Not in the claim's atomic update on purpose (keeps claim cheap). If we
      // crash right here the task is RUNNING without an attempt record; its
      // lease expires and another worker takes it over.
      await TaskExecution.create({
        taskId: task._id,
        executionId: task.executionId,
        attempt: task.attempt,
        workerId,
        leaseToken: task.leaseToken,
      });

      // POISON-PILL GUARD. Takeovers also consume attempts. A task whose
      // previous attempts all vanished (e.g. it crashes its worker every time)
      // would otherwise be taken over forever. Past maxAttempts: dead-letter
      // it without running it again.
      if (task.attempt > task.maxAttempts) {
        await engine.failTask({
          taskId: task._id,
          leaseToken: task.leaseToken,
          error: new Error(`Exceeded ${task.maxAttempts} attempts (previous attempts were abandoned by lost workers)`),
        });
        return null;
      }

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
     * A task attempt failed. ONE transaction decides between:
     *
     *   RETRY        error is transient AND attempts remain AND the run is
     *                still RUNNING  ->  RUNNING -> RETRYING, and after commit
     *                schedule a delayed wake-up (exponential backoff + jitter).
     *                pendingTasks is untouched: the task isn't finished.
     *
     *   DEAD_LETTER  transient error but attempts EXHAUSTED -> RUNNING -> FAILED
     *                -> DEAD_LETTER: parked for a human to inspect.
     *
     *   FAILED       non-retryable error (or the run already failed) ->
     *                RUNNING -> FAILED.
     *
     * Either terminal outcome then applies FAIL-FAST: unstarted tasks
     * (PENDING / READY / QUEUED / RETRYING) are CANCELLED and the execution
     * becomes FAILED. Tasks already RUNNING may finish; nothing new starts.
     *
     * The first read is conditional on status RUNNING + this leaseToken, so a
     * duplicate or stale (fenced) report is a no-op.
     *
     * @returns {Promise<{ applied: boolean, outcome?: "RETRYING"|"FAILED"|"DEAD_LETTER", delayMs?: number }>}
     */
    async failTask({ taskId, leaseToken, error }) {
      const message = String(error?.message ?? error ?? "Task failed").slice(0, 2000);
      const retryable = isRetryable(error);
      let result = { applied: false };
      let retryTask = null;

      await connection.transaction(async (session) => {
        result = { applied: false };
        retryTask = null;
        const finishedAt = now();

        const task = await Task.findOne({ _id: taskId, status: T.RUNNING, leaseToken }, null, { session });
        if (!task) return; // duplicate or stale report

        await TaskExecution.updateOne(
          { taskId, attempt: task.attempt },
          {
            $set: {
              status: error?.name === "TimeoutError" ? ATTEMPT_STATUS.TIMED_OUT : ATTEMPT_STATUS.FAILED,
              finishedAt,
              durationMs: task.startedAt ? finishedAt - task.startedAt : null,
              error: { message, retryable },
            },
          },
          { session }
        );

        const execution = await WorkflowExecution.findById(task.executionId, null, { session });
        const attemptsLeft = task.attempt < task.maxAttempts;

        // ---- RETRY --------------------------------------------------------
        if (retryable && attemptsLeft && execution.status === E.RUNNING) {
          const delayMs = backoff(task.attempt, task.baseDelayMs);
          const won = await transitionTask(taskId, T.RUNNING, T.RETRYING, {
            where: { leaseToken },
            set: {
              error: message,
              leaseOwner: null,
              leaseExpiresAt: null,
              retryAt: new Date(finishedAt.getTime() + delayMs),
            },
            session,
          });
          if (!won) return;
          retryTask = task;
          result = { applied: true, outcome: T.RETRYING, delayMs };
          return;
        }

        // ---- TERMINAL: FAILED or DEAD_LETTER -------------------------------
        const outcome = retryable && !attemptsLeft ? T.DEAD_LETTER : T.FAILED;
        const won = await transitionTask(taskId, T.RUNNING, T.FAILED, {
          where: { leaseToken },
          set: { error: message, completedAt: finishedAt, leaseOwner: null, leaseExpiresAt: null },
          session,
        });
        if (!won) return;
        if (outcome === T.DEAD_LETTER) {
          await transitionTask(taskId, T.FAILED, T.DEAD_LETTER, { session });
        }

        const updated = await WorkflowExecution.findOneAndUpdate(
          { _id: task.executionId },
          { $inc: { pendingTasks: -1 } },
          { returnDocument: "after", session }
        );

        if (updated.status === E.RUNNING) {
          const cancelled = await Task.updateMany(
            { executionId: task.executionId, status: { $in: [T.PENDING, T.READY, T.QUEUED, T.RETRYING] } },
            { $set: { status: T.CANCELLED, completedAt: finishedAt } },
            { session }
          );
          const why =
            outcome === T.DEAD_LETTER
              ? `failed after ${task.attempt} attempt(s) and was dead-lettered`
              : "failed";
          assertTransition("execution", E.RUNNING, E.FAILED);
          await WorkflowExecution.updateOne(
            { _id: updated._id, status: E.RUNNING },
            {
              $set: { status: E.FAILED, error: `Task "${task.key}" ${why}: ${message}`, completedAt: finishedAt },
              $inc: { pendingTasks: -cancelled.modifiedCount },
            },
            { session }
          );
          logger.warn(
            { executionId: String(updated._id), taskKey: task.key, outcome, cancelled: cancelled.modifiedCount },
            "execution failed (fail-fast)"
          );
        }

        result = { applied: true, outcome };
      });

      if (retryTask) {
        logger.info(
          { taskKey: retryTask.key, attempt: retryTask.attempt, delayMs: result.delayMs },
          "task will be retried"
        );
        await enqueueRetrySafely(retryTask, result.delayMs);
      }
      return result;
    },

    /**
     * RECONCILER — MongoDB (the whiteboard) is the truth; make Redis agree.
     * Runs periodically. Each sweep is safe to run concurrently with normal
     * operation and with other reconcilers, because every step is either a
     * CAS (READY -> QUEUED) or an idempotent enqueue (Redis dedupes by id).
     *
     *   1. READY for longer than staleMs  -> never dispatched (crash between
     *      commit and dispatch): dispatch now.
     *   2. QUEUED for longer than staleMs -> maybe missing from Redis (Redis
     *      was down during enqueue, or lost data): enqueue again (no-op if
     *      it's still there).
     *   3. RUNNING with an expired lease  -> its worker is gone and Redis may
     *      have lost the lease too: enqueue so a worker can take it over.
     *   4. RETRYING whose retryAt passed more than staleMs ago -> the delayed
     *      wake-up was lost (Redis down when scheduling it): enqueue now.
     *
     * @returns {Promise<{ ready: number, queued: number, running: number, retrying: number }>}
     *   queued/running count enqueue calls made, not tasks actually missing
     */
    async reconcile({ staleMs, limit = 100 }) {
      const cutoff = new Date(Date.now() - staleMs);
      const counts = { ready: 0, queued: 0, running: 0, retrying: 0 };

      const stuckReady = await Task.find({ status: T.READY, readyAt: { $lt: cutoff } })
        .select("_id key executionId")
        .limit(limit);
      for (const task of stuckReady) {
        if (await dispatchTask(task)) counts.ready += 1;
      }

      const staleQueued = await Task.find({ status: T.QUEUED, queuedAt: { $lt: cutoff } })
        .select("_id key executionId")
        .limit(limit);
      for (const task of staleQueued) {
        if (await enqueueSafely(task)) counts.queued += 1;
      }

      const expiredRunning = await Task.find({
        status: T.RUNNING,
        $expr: { $lt: ["$leaseExpiresAt", "$$NOW"] },
      })
        .select("_id key executionId")
        .limit(limit);
      for (const task of expiredRunning) {
        if (await enqueueSafely(task)) counts.running += 1;
      }

      const overdueRetries = await Task.find({ status: T.RETRYING, retryAt: { $lt: cutoff } })
        .select("_id key executionId")
        .limit(limit);
      for (const task of overdueRetries) {
        if (await enqueueSafely(task)) counts.retrying += 1;
      }

      if (counts.ready + counts.running + counts.retrying > 0) logger.warn(counts, "reconciler re-dispatched tasks");
      return counts;
    },
  };

  return engine;
}
