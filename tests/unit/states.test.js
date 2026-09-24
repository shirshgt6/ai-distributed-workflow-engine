import {
  TASK_STATUS as T,
  EXECUTION_STATUS as E,
  canTransition,
  assertTransition,
  isTerminal,
  InvalidTransitionError,
  TRANSITIONS,
} from "../../src/workflow/states.js";

describe("task state machine", () => {
  test("happy path is legal", () => {
    const path = [T.PENDING, T.READY, T.QUEUED, T.RUNNING, T.COMPLETED];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition("task", path[i], path[i + 1])).toBe(true);
    }
  });

  test("RUNNING may go to exactly these states", () => {
    const allowed = Object.values(T).filter((to) => canTransition("task", T.RUNNING, to));
    expect(allowed.sort()).toEqual(
      [T.COMPLETED, T.FAILED, T.RETRYING, T.WAITING_FOR_APPROVAL, T.QUEUED, T.CANCELLED].sort()
    );
  });

  test("no going backwards to PENDING / READY from RUNNING", () => {
    expect(canTransition("task", T.RUNNING, T.PENDING)).toBe(false);
    expect(canTransition("task", T.RUNNING, T.READY)).toBe(false);
  });

  test("retry loop: RUNNING -> RETRYING -> QUEUED -> RUNNING", () => {
    expect(canTransition("task", T.RUNNING, T.RETRYING)).toBe(true);
    expect(canTransition("task", T.RETRYING, T.QUEUED)).toBe(true);
    expect(canTransition("task", T.QUEUED, T.RUNNING)).toBe(true);
  });

  test("terminal states have NO outgoing transitions", () => {
    for (const s of [T.COMPLETED, T.DEAD_LETTER, T.CANCELLED]) {
      expect(isTerminal("task", s)).toBe(true);
      for (const to of Object.values(T)) {
        expect(canTransition("task", s, to)).toBe(false);
      }
    }
  });

  test("FAILED is not terminal: it can only be parked in DEAD_LETTER", () => {
    expect(isTerminal("task", T.FAILED)).toBe(false);
    expect(Object.values(T).filter((to) => canTransition("task", T.FAILED, to))).toEqual([T.DEAD_LETTER]);
  });

  test("every status appears in the table (no forgotten state)", () => {
    expect(Object.keys(TRANSITIONS.task).sort()).toEqual(Object.values(T).sort());
    expect(Object.keys(TRANSITIONS.execution).sort()).toEqual(Object.values(E).sort());
  });

  test("assertTransition throws a descriptive error", () => {
    expect(() => assertTransition("task", T.COMPLETED, T.READY)).toThrow(InvalidTransitionError);
    expect(() => assertTransition("task", T.COMPLETED, T.READY)).toThrow("Invalid task transition: COMPLETED -> READY");
  });

  test("unknown machine is a programming error", () => {
    expect(() => canTransition("banana", "A", "B")).toThrow(/Unknown state machine/);
  });
});

describe("execution state machine", () => {
  test("pause / resume", () => {
    expect(canTransition("execution", E.RUNNING, E.PAUSED)).toBe(true);
    expect(canTransition("execution", E.PAUSED, E.RUNNING)).toBe(true);
  });

  test("cannot pause something that is not running", () => {
    expect(canTransition("execution", E.PENDING, E.PAUSED)).toBe(false);
    expect(canTransition("execution", E.COMPLETED, E.PAUSED)).toBe(false);
  });

  test("terminal executions never change", () => {
    for (const s of [E.COMPLETED, E.FAILED, E.CANCELLED]) {
      expect(isTerminal("execution", s)).toBe(true);
    }
  });
});
