import { createWorkflowSchema, updateWorkflowSchema, LIMITS } from "../../src/workflow/workflow.schemas.js";

const parse = (body) => createWorkflowSchema.body.safeParse(body);
const task = (key, extra = {}) => ({ key, type: "noop", ...extra });

describe("workflow shape validation", () => {
  test("applies defaults to each task", () => {
    const result = parse({ name: "  Invoice  ", tasks: [task("A")] });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe("Invoice");
    expect(result.data.tasks[0]).toEqual({
      key: "A",
      type: "noop",
      dependsOn: [],
      config: {},
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000 },
      timeoutMs: 30000,
    });
  });

  test("strips fields the client must not set (ownerId, version, status...)", () => {
    const result = parse({ name: "x", tasks: [task("A")], ownerId: "someone-else", version: 99, status: "RUNNING" });
    expect(result.data).not.toHaveProperty("ownerId");
    expect(result.data).not.toHaveProperty("version");
    expect(result.data).not.toHaveProperty("status");
  });

  test("requires at least one task and caps the count", () => {
    expect(parse({ name: "x", tasks: [] }).success).toBe(false);
    const tooMany = Array.from({ length: LIMITS.MAX_TASKS + 1 }, (_, i) => task(`t${i}`));
    expect(parse({ name: "x", tasks: tooMany }).success).toBe(false);
  });

  test("rejects bad task keys and types", () => {
    expect(parse({ name: "x", tasks: [task("has space")] }).success).toBe(false);
    expect(parse({ name: "x", tasks: [{ key: "A", type: "Bad Type" }] }).success).toBe(false);
  });

  test("bounds retry policy and timeout", () => {
    expect(parse({ name: "x", tasks: [task("A", { retryPolicy: { maxAttempts: 0 } })] }).success).toBe(false);
    expect(parse({ name: "x", tasks: [task("A", { retryPolicy: { maxAttempts: 11 } })] }).success).toBe(false);
    expect(parse({ name: "x", tasks: [task("A", { timeoutMs: 50 })] }).success).toBe(false);
  });

  test("shape only: graph problems (unknown dep, cycle) are NOT caught here — Phase 4", () => {
    const cyclic = { name: "x", tasks: [task("A", { dependsOn: ["B"] }), task("B", { dependsOn: ["A"] })] };
    expect(parse(cyclic).success).toBe(true);
  });

  test("update requires the version being edited", () => {
    const params = { id: "652f1c2b9d1e8a0012345678" };
    expect(updateWorkflowSchema.body.safeParse({ name: "x", tasks: [task("A")] }).success).toBe(false);
    expect(updateWorkflowSchema.body.safeParse({ name: "x", tasks: [task("A")], version: 1 }).success).toBe(true);
    expect(updateWorkflowSchema.params.safeParse(params).success).toBe(true);
    expect(updateWorkflowSchema.params.safeParse({ id: "nope" }).success).toBe(false);
  });
});
