// DAG (Directed Acyclic Graph) validation and analysis for workflow definitions.
//
// Input: the task list of a workflow, e.g.
//   [{ key: "A", dependsOn: [] }, { key: "B", dependsOn: ["A"] }, ...]
// An edge  A -> B  means "B depends on A" (A must complete before B starts).
//
// Two classic algorithms, each used for what it is best at:
//   * Kahn's algorithm (BFS on in-degrees): topological order + parallel
//     "levels", and detects THAT a cycle exists. Iterative — no recursion.
//   * DFS with three colours: finds WHICH nodes form a cycle, so the error
//     message can say "A -> B -> C -> A" instead of just "there is a cycle".
//
// Both are O(V + E): every task and every dependency edge is visited once.

export const DAG_ERROR = Object.freeze({
  DUPLICATE_KEY: "DUPLICATE_KEY",
  SELF_DEPENDENCY: "SELF_DEPENDENCY",
  DUPLICATE_DEPENDENCY: "DUPLICATE_DEPENDENCY",
  UNKNOWN_DEPENDENCY: "UNKNOWN_DEPENDENCY",
  CYCLE: "CYCLE",
});

/**
 * Validate a workflow's task graph. Collects ALL problems (not just the
 * first), so a user can fix everything in one round-trip.
 *
 * @param {{ key: string, dependsOn?: string[] }[]} tasks
 * @returns {{
 *   valid: boolean,
 *   errors: { code: string, message: string, task?: string, dependency?: string, cycle?: string[] }[],
 *   order: string[],       // a topological order (only when valid)
 *   levels: string[][],    // tasks grouped into parallel "waves" (only when valid)
 * }}
 */
export function validateDag(tasks) {
  const errors = [];

  // --- 1. Structural checks (need a clean key set before graph algorithms) --
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.key)) {
      errors.push({
        code: DAG_ERROR.DUPLICATE_KEY,
        task: task.key,
        message: `Task key "${task.key}" is used more than once`,
      });
    }
    seen.add(task.key);
  }

  for (const task of tasks) {
    const deps = task.dependsOn ?? [];
    const counted = new Set();
    for (const dep of deps) {
      if (dep === task.key) {
        errors.push({
          code: DAG_ERROR.SELF_DEPENDENCY,
          task: task.key,
          message: `Task "${task.key}" depends on itself`,
        });
      } else if (!seen.has(dep)) {
        errors.push({
          code: DAG_ERROR.UNKNOWN_DEPENDENCY,
          task: task.key,
          dependency: dep,
          message: `Task "${task.key}" depends on unknown task "${dep}"`,
        });
      }
      if (counted.has(dep)) {
        // Would make remainingDeps = 2 for a parent that completes ONCE:
        // the child could never reach 0 and would wait forever.
        errors.push({
          code: DAG_ERROR.DUPLICATE_DEPENDENCY,
          task: task.key,
          dependency: dep,
          message: `Task "${task.key}" lists dependency "${dep}" more than once`,
        });
      }
      counted.add(dep);
    }
  }

  // Graph algorithms assume unique keys and known edges; if the structure is
  // broken, report that first rather than confusing cycle results.
  if (errors.length > 0) {
    return { valid: false, errors, order: [], levels: [] };
  }

  // --- 2. Cycle detection + ordering (Kahn) --------------------------------
  const { order, levels, unprocessed } = kahn(tasks);

  if (unprocessed.length > 0) {
    // Kahn tells us THAT there is a cycle: some tasks never reached
    // in-degree 0. Those are cycle members or tasks downstream of a cycle.
    // DFS pinpoints an actual cycle among them for a useful message.
    const cycle = findCycle(tasks, new Set(unprocessed));
    errors.push({
      code: DAG_ERROR.CYCLE,
      cycle,
      message: `Dependency cycle: ${cycle.join(" -> ")}`,
    });
    return { valid: false, errors, order: [], levels: [] };
  }

  return { valid: true, errors: [], order, levels };
}

/**
 * Kahn's algorithm — "simulate running the workflow without running it".
 *
 *   in-degree(task) = number of dependencies = the engine's remainingDeps.
 *   1. Every task with in-degree 0 can start: put it in the current wave.
 *   2. "Complete" the wave: for each task in it, decrement each child's
 *      in-degree. Children reaching 0 form the NEXT wave.
 *   3. Repeat until a wave is empty.
 *   If some tasks were never emitted, they wait on each other: a cycle.
 *
 * Processing wave-by-wave (instead of one queue item at a time) gives the
 * parallel levels for free: everything in one wave can run concurrently.
 * levels.length = length of the longest dependency chain (critical path,
 * counted in tasks) = minimum number of sequential steps, even with
 * unlimited workers.
 *
 * Order inside a wave follows input order, so results are deterministic.
 */
export function kahn(tasks) {
  const inDegree = new Map();
  const children = new Map(); // parent key -> keys that depend on it

  for (const task of tasks) {
    inDegree.set(task.key, (task.dependsOn ?? []).length);
    children.set(task.key, []);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      children.get(dep).push(task.key);
    }
  }

  const order = [];
  const levels = [];
  let wave = tasks.filter((t) => inDegree.get(t.key) === 0).map((t) => t.key);

  while (wave.length > 0) {
    levels.push(wave);
    order.push(...wave);
    const next = [];
    for (const key of wave) {
      for (const child of children.get(key)) {
        const remaining = inDegree.get(child) - 1;
        inDegree.set(child, remaining);
        if (remaining === 0) next.push(child);
      }
    }
    wave = next;
  }

  const emitted = new Set(order);
  const unprocessed = tasks.map((t) => t.key).filter((k) => !emitted.has(k));
  return { order, levels, unprocessed };
}

/**
 * DFS with three colours to return ONE concrete cycle as a path,
 * e.g. ["A", "B", "C", "A"].
 *
 *   WHITE = not visited yet
 *   GREY  = on the current DFS path ("in progress")
 *   BLACK = fully explored, known to lead to no cycle
 *
 * Reaching a GREY node again means we walked back into our own path: the
 * path from that node to here is a cycle. (Reaching BLACK is fine — that's
 * just two paths meeting, like the diamond A->B->D and A->C->D.)
 *
 * We follow edges task -> dependency. Recursion depth is bounded by the
 * number of tasks (<= LIMITS.MAX_TASKS = 100), so the call stack is safe.
 *
 * @param {{ key: string, dependsOn?: string[] }[]} tasks
 * @param {Set<string>} candidates keys that Kahn could not process
 * @returns {string[]} cycle path, first key repeated at the end
 */
export function findCycle(tasks, candidates) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn ?? []]));
  const colour = new Map(tasks.map((t) => [t.key, WHITE]));
  const path = [];

  function visit(key) {
    colour.set(key, GREY);
    path.push(key);
    for (const dep of deps.get(key)) {
      if (colour.get(dep) === GREY) {
        // Cycle found: slice the current path from where `dep` appears.
        return [...path.slice(path.indexOf(dep)), dep];
      }
      if (colour.get(dep) === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    path.pop();
    colour.set(key, BLACK);
    return null;
  }

  for (const key of candidates) {
    if (colour.get(key) === WHITE) {
      const found = visit(key);
      if (found) return found.reverse(); // report in execution direction: A -> B means B depends on A
    }
  }
  // Unreachable when called with Kahn's leftovers (they always contain a cycle).
  return [...candidates];
}
