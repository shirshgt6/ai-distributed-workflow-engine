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
 * A worker claims a QUEUED task: QUEUED -> RUNNING, in ONE atomic update that
 * also increments `attempt` and the fencing `leaseToken`.
 *
 * Returns the updated task (with the NEW leaseToken the worker must present
 * when it reports the result), or null if the task is no longer QUEUED —
 * cancelled, or already claimed by someone else. null means "skip it".
 *
 * @param {import('mongoose').Types.ObjectId|string} taskId
 * @param {string} workerId
 */
export async function claimQueuedTask(taskId, workerId) {
  assertTransition("task", TASK_STATUS.QUEUED, TASK_STATUS.RUNNING);
  return Task.findOneAndUpdate(
    { _id: taskId, status: TASK_STATUS.QUEUED },
    {
      $set: { status: TASK_STATUS.RUNNING, leaseOwner: workerId, startedAt: new Date() },
      $inc: { attempt: 1, leaseToken: 1 },
    },
    { returnDocument: "after" }
  );
}
