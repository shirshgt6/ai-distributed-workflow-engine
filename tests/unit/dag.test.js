import { validateDag, kahn, findCycle, DAG_ERROR } from "../../src/workflow/dag.js";

// Tiny builder: t("B", "A") = task B depends on A.
const t = (key, ...dependsOn) => ({ key, dependsOn });
const codes = (result) => result.errors.map((e) => e.code);

describe("valid graphs", () => {
  test("diamond A -> (B, C) -> D: order, parallel levels, critical path", () => {
    const result = validateDag([t("A"), t("B", "A"), t("C", "A"), t("D", "B", "C")]);
    expect(result.valid).toBe(true);
    expect(result.order).toEqual(["A", "B", "C", "D"]);
    expect(result.levels).toEqual([["A"], ["B", "C"], ["D"]]); // B and C can run in parallel
    expect(result.levels.length).toBe(3); // critical path: A -> B -> D (3 tasks)
  });

  test("single task", () => {
    expect(validateDag([t("A")])).toMatchObject({ valid: true, order: ["A"], levels: [["A"]] });
  });

  test("fully independent tasks all run in the first wave", () => {
    expect(validateDag([t("A"), t("B"), t("C")]).levels).toEqual([["A", "B", "C"]]);
  });

  test("input order does not matter — a child listed before its parent is fine", () => {
    const result = validateDag([t("D", "B", "C"), t("C", "A"), t("B", "A"), t("A")]);
    expect(result.valid).toBe(true);
    expect(result.levels).toEqual([["A"], ["C", "B"], ["D"]]);
  });

  test("disconnected components are allowed", () => {
    const result = validateDag([t("A"), t("B", "A"), t("X"), t("Y", "X")]);
    expect(result.levels).toEqual([["A", "X"], ["B", "Y"]]);
  });

  test("every task appears after all of its dependencies (topological property)", () => {
    const tasks = [t("E", "C", "D"), t("A"), t("D", "B"), t("B", "A"), t("C", "A"), t("F", "E", "A")];
    const { order } = validateDag(tasks);
    const position = new Map(order.map((k, i) => [k, i]));
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        expect(position.get(dep)).toBeLessThan(position.get(task.key));
      }
    }
  });

  test("a long chain of 100 tasks (the max) validates without stack issues", () => {
    const chain = Array.from({ length: 100 }, (_, i) => (i === 0 ? t("t0") : t(`t${i}`, `t${i - 1}`)));
    const result = validateDag(chain);
    expect(result.valid).toBe(true);
    expect(result.levels).toHaveLength(100); // fully sequential: no parallelism possible
  });
});

describe("cycles", () => {
  test("two-node cycle A <-> B", () => {
    const result = validateDag([t("A", "B"), t("B", "A")]);
    expect(result.valid).toBe(false);
    expect(codes(result)).toEqual([DAG_ERROR.CYCLE]);
    expect(result.errors[0].cycle).toEqual(["A", "B", "A"]);
    expect(result.errors[0].message).toBe("Dependency cycle: A -> B -> A");
  });

  test("three-node cycle is reported in execution direction", () => {
    // A needs C, B needs A, C needs B  ==>  A -> B -> C -> A
    const result = validateDag([t("A", "C"), t("B", "A"), t("C", "B")]);
    expect(result.errors[0].cycle).toEqual(["A", "B", "C", "A"]);
  });

  test("cycle hidden behind a valid prefix: A -> B -> C -> D -> B", () => {
    const result = validateDag([t("A"), t("B", "A", "D"), t("C", "B"), t("D", "C")]);
    expect(result.valid).toBe(false);
    const { cycle } = result.errors[0];
    expect(cycle[0]).toBe(cycle[cycle.length - 1]); // closed path
    expect(new Set(cycle)).toEqual(new Set(["B", "C", "D"])); // A is NOT part of the cycle
  });

  test("diamond is NOT a cycle (two paths meeting is fine)", () => {
    expect(validateDag([t("A"), t("B", "A"), t("C", "A"), t("D", "B", "C")]).valid).toBe(true);
  });

  test("invalid graphs return no order/levels (never half-trust a broken graph)", () => {
    expect(validateDag([t("A", "B"), t("B", "A")])).toMatchObject({ order: [], levels: [] });
  });
});

describe("structural errors", () => {
  test("self dependency", () => {
    const result = validateDag([t("A", "A")]);
    expect(codes(result)).toEqual([DAG_ERROR.SELF_DEPENDENCY]);
  });

  test("unknown dependency names the missing task", () => {
    const result = validateDag([t("A"), t("B", "Z")]);
    expect(result.errors).toEqual([expect.objectContaining({ code: DAG_ERROR.UNKNOWN_DEPENDENCY, task: "B", dependency: "Z" })]);
  });

  test("duplicate key", () => {
    expect(codes(validateDag([t("A"), t("A")]))).toEqual([DAG_ERROR.DUPLICATE_KEY]);
  });

  test("duplicate dependency entry (would make the child wait forever)", () => {
    const result = validateDag([t("A"), t("B", "A", "A")]);
    expect(codes(result)).toEqual([DAG_ERROR.DUPLICATE_DEPENDENCY]);
  });

  test("ALL problems are reported at once", () => {
    const result = validateDag([t("A", "A"), t("B", "Z"), t("B"), t("C", "A", "A")]);
    expect(codes(result).sort()).toEqual(
      [DAG_ERROR.SELF_DEPENDENCY, DAG_ERROR.UNKNOWN_DEPENDENCY, DAG_ERROR.DUPLICATE_KEY, DAG_ERROR.DUPLICATE_DEPENDENCY].sort()
    );
  });

  test("missing dependsOn is treated as no dependencies", () => {
    expect(validateDag([{ key: "A" }, { key: "B", dependsOn: ["A"] }]).valid).toBe(true);
  });
});

describe("building blocks", () => {
  test("kahn lists the tasks it could not process (cycle members + their descendants)", () => {
    // B <-> C is a cycle; D depends on C so it is blocked too; A is fine.
    const { order, unprocessed } = kahn([t("A"), t("B", "C"), t("C", "B"), t("D", "C")]);
    expect(order).toEqual(["A"]);
    expect(unprocessed.sort()).toEqual(["B", "C", "D"]);
  });

  test("findCycle ignores the merely-blocked descendant and returns the real loop", () => {
    const tasks = [t("B", "C"), t("C", "B"), t("D", "C")];
    const cycle = findCycle(tasks, new Set(["D", "B", "C"]));
    expect(new Set(cycle)).toEqual(new Set(["B", "C"]));
  });
});
