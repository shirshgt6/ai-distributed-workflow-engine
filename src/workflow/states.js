// Explicit state machines for workflow executions and tasks.
//
// Every status change in the system goes through canTransition() /
// assertTransition() — there is no other legal way to move a status. A
// transition not listed here is a bug, and it fails loudly.
//
// Two layers of protection, both needed:
//   1. THIS table:   "is RUNNING -> READY ever legal?"            (logic)
//   2. conditional DB update { status: from }:
//                    "is the task STILL in `from` right now?"     (concurrency)
// The table alone can't stop two workers racing; the conditional update
// alone can't stop a coding mistake like COMPLETED -> READY.

export const EXECUTION_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  WAITING_FOR_APPROVAL: "WAITING_FOR_APPROVAL",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

export const TASK_STATUS = Object.freeze({
  PENDING: "PENDING", // waiting for dependencies
  READY: "READY", // all dependencies done, not yet handed to the queue
  QUEUED: "QUEUED", // in the queue, waiting for a worker
  RUNNING: "RUNNING", // a worker holds it
  RETRYING: "RETRYING", // failed, waiting for its backoff delay
  WAITING_FOR_APPROVAL: "WAITING_FOR_APPROVAL",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED", // failed for good (non-retryable or retries exhausted)
  DEAD_LETTER: "DEAD_LETTER", // parked for a human to inspect
  CANCELLED: "CANCELLED",
});

const E = EXECUTION_STATUS;
const T = TASK_STATUS;

// from -> allowed next states. Terminal states map to an EMPTY list.
const EXECUTION_TRANSITIONS = Object.freeze({
  [E.PENDING]: [E.RUNNING, E.CANCELLED],
  [E.RUNNING]: [E.PAUSED, E.WAITING_FOR_APPROVAL, E.COMPLETED, E.FAILED, E.CANCELLED],
  // A task can fail for good while paused (tasks already running finish).
  [E.PAUSED]: [E.RUNNING, E.FAILED, E.CANCELLED],
  [E.WAITING_FOR_APPROVAL]: [E.RUNNING, E.FAILED, E.CANCELLED],
  [E.COMPLETED]: [],
  [E.FAILED]: [],
  [E.CANCELLED]: [],
});

const TASK_TRANSITIONS = Object.freeze({
  [T.PENDING]: [T.READY, T.CANCELLED],
  [T.READY]: [T.QUEUED, T.CANCELLED],
  // QUEUED -> READY: the item was lost from the Redis queue (e.g. Redis
  // restarted) and a reconciler hands it back to be re-enqueued (Phase 10).
  [T.QUEUED]: [T.RUNNING, T.READY, T.CANCELLED],
  // RUNNING -> QUEUED: the worker died mid-task (lease expired) and the task is
  // requeued WITHOUT counting as a failed attempt of the task's own logic.
  [T.RUNNING]: [T.COMPLETED, T.FAILED, T.RETRYING, T.WAITING_FOR_APPROVAL, T.QUEUED, T.CANCELLED],
  [T.RETRYING]: [T.QUEUED, T.CANCELLED],
  [T.WAITING_FOR_APPROVAL]: [T.COMPLETED, T.FAILED, T.CANCELLED],
  [T.FAILED]: [T.DEAD_LETTER],
  [T.COMPLETED]: [],
  [T.DEAD_LETTER]: [],
  [T.CANCELLED]: [],
});

const MACHINES = Object.freeze({
  execution: EXECUTION_TRANSITIONS,
  task: TASK_TRANSITIONS,
});

export class InvalidTransitionError extends Error {
  constructor(machine, from, to) {
    super(`Invalid ${machine} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

/**
 * @param {"execution"|"task"} machine
 * @param {string} from
 * @param {string} to
 */
export function canTransition(machine, from, to) {
  const table = MACHINES[machine];
  if (!table) throw new Error(`Unknown state machine: ${machine}`);
  return table[from]?.includes(to) ?? false;
}

export function assertTransition(machine, from, to) {
  if (!canTransition(machine, from, to)) {
    throw new InvalidTransitionError(machine, from, to);
  }
}

/** A terminal state has no outgoing transitions: once there, never leaves. */
export function isTerminal(machine, status) {
  return MACHINES[machine][status]?.length === 0;
}

// Exported for tests / docs generation.
export const TRANSITIONS = MACHINES;
