import { Task } from "../models/task.model.js";
import { assertTransition, TASK_STATUS } from "../workflow/states.js";

/**
 * Move a task from `from` to `to` — atomically, and only if it is STILL in
 * `from`. This is compare-and-set (CAS) on the status field.
 *
 *   updateOne({ _id, status: from }, { $set: { status: to } })
 *
 * If another worker / the sweeper / a cancel request already moved the task,
 * the filter matches nothing and we get `false` — we lost the race and must
 * NOT act as if we won (no enqueuing, no notifying dependents...).
 *
 * @param {import('mongoose').Types.ObjectId|string} taskId
 * @param {string} from expected current status
 * @param {string} to   new status (must be a legal transition from `from`)
 * @param {{ set?: object, inc?: object, where?: object, session?: import('mongoose').ClientSession }} [options]
 *   set/inc: extra fields to change in the SAME atomic update
 *   where:   extra conditions, e.g. { leaseToken: 7 } for fencing
 *   session: run inside a transaction
 * @returns {Promise<boolean>} true if WE performed the transition
 * @throws {InvalidTransitionError} if from -> to is never legal (a bug)
 */
export async function transitionTask(taskId, from, to, { set = {}, inc, where = {}, session } = {}) {
  assertTransition("task", from, to);

  const update = { $set: { ...set, status: to } };
  if (inc) update.$inc = inc;

  const result = await Task.updateOne({ ...where, _id: taskId, status: from }, update, { session });
  return result.modifiedCount === 1;
}

/**
 * A worker claims a task: -> RUNNING, in ONE atomic update that also
 * increments `attempt`, increments the fencing `leaseToken`, and sets a
 * lease deadline. Claimable when the task is either:
 *
 *   QUEUED                              (the normal case), or
 *   RUNNING with an EXPIRED lease       (TAKEOVER: the previous worker died
 *                                        or hung past timeout + grace)
 *
 * A takeover is logically RUNNING -> QUEUED -> RUNNING done in one step; the
 * new leaseToken fences off any late report from the dead attempt.
 *
 * Lease maths uses MongoDB's clock ($$NOW), not this process's clock, so
 * workers with skewed clocks agree on whether a lease has expired.
 * leaseExpiresAt = now + task.timeoutMs + leaseGraceMs: a healthy worker's
 * handler is stopped by its timeout well before the lease runs out.
 *
 * Returns the updated task (carrying the NEW leaseToken the worker must
 * present when reporting), or null: already running elsewhere with a live
 * lease, finished, or cancelled. null means "skip it".
 *
 * @param {import('mongoose').Types.ObjectId|string} taskId
 * @param {string} workerId
 * @param {{ leaseGraceMs: number }} options
 */
export async function claimTask(taskId, workerId, { leaseGraceMs }) {
  assertTransition("task", TASK_STATUS.QUEUED, TASK_STATUS.RUNNING);
  assertTransition("task", TASK_STATUS.RUNNING, TASK_STATUS.QUEUED); // takeover path
  return Task.findOneAndUpdate(
    {
      _id: taskId,
      $or: [
        { status: TASK_STATUS.QUEUED },
        { status: TASK_STATUS.RUNNING, $expr: { $lt: ["$leaseExpiresAt", "$$NOW"] } },
      ],
    },
    // An aggregation-pipeline update, so new values can be computed from the
    // document's own fields ($timeoutMs) and the server clock ($$NOW).
    [
      {
        $set: {
          status: { $literal: TASK_STATUS.RUNNING },
          leaseOwner: { $literal: workerId },
          startedAt: "$$NOW",
          attempt: { $add: ["$attempt", 1] },
          leaseToken: { $add: ["$leaseToken", 1] },
          leaseExpiresAt: { $add: ["$$NOW", { $add: ["$timeoutMs", leaseGraceMs] }] },
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true }
  );
}
