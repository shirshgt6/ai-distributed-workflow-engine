import { z } from "zod";
import { evaluateArithmetic } from "../../src/ai/agent/calculator.js";
import { runAgent } from "../../src/ai/agent/agent.js";
import { selectTools } from "../../src/ai/agent/tools.js";
import { createMockProvider } from "../../src/ai/providers/mock.js";
import { PERMISSIONS } from "../../src/auth/permissions.js";

describe("safe calculator (no eval)", () => {
  test.each([
    ["2 + 3 * 4", 14],
    ["(2 + 3) * 4", 20],
    ["-3 + 5", 2],
    ["2 ^ 3 ^ 2", 512], // right-associative
    ["18 - 5 % 3", 16],
    ["10 / 4", 2.5],
    ["0.1 + 0.2", 0.3],
  ])("%s = %s", (expr, expected) => expect(evaluateArithmetic(expr)).toBe(expected));

  test.each([
    ["process.exit()", /only numbers/],
    ["require('fs')", /only numbers/],
    ["constructor", /only numbers/],
    ["1 / 0", /division by zero/],
    ["(1 + 2", /missing closing/],
    ["2 ^ 1000", /exponent too large/],
    ["1 +", /expected a number/],
    ["9".repeat(201), /too long/],
  ])("rejects %s", (expr, error) => expect(() => evaluateArithmetic(expr)).toThrow(error));
});

describe("selectTools: allowlist ∩ registry ∩ role", () => {
  const registry = {
    calculator: { permission: null },
    search_knowledge_base: { permission: PERMISSIONS.WORKFLOW_READ },
    admin_only: { permission: PERMISSIONS.USER_MANAGE },
  };
  test("role permissions remove tools the owner may not use", () => {
    const { allowed, denied } = selectTools(registry, { role: "operator" });
    expect(Object.keys(allowed).sort()).toEqual(["calculator", "search_knowledge_base"]);
    expect(denied).toEqual(["admin_only"]);
  });
  test("task allowlist narrows further; unknown names are an error, not ignored", () => {
    expect(Object.keys(selectTools(registry, { role: "admin", allowlist: ["calculator"] }).allowed)).toEqual(["calculator"]);
    expect(() => selectTools(registry, { role: "admin", allowlist: ["shell"] })).toThrow(/Unknown agent tool/);
  });
});

describe("agent loop", () => {
  const calls = [];
  const tools = {
    calculator: {
      description: "math",
      schema: z.object({ expression: z.string() }),
      timeoutMs: 1000,
      run: async ({ expression }) => {
        calls.push(expression);
        return { result: evaluateArithmetic(expression) };
      },
    },
    slow: { description: "never returns", schema: z.object({}), timeoutMs: 30, run: () => new Promise(() => {}) },
    echo_owner: { description: "who am I", schema: z.object({}), timeoutMs: 1000, run: async (_a, ctx) => ({ ownerId: ctx.ownerId }) },
  };
  const script = (...replies) => createMockProvider({ respond: (_req, i) => JSON.stringify(replies[Math.min(i, replies.length - 1)]) });
  const run = (provider, extra = {}) =>
    runAgent({ provider, model: "m", tools, goal: "What is 18 minus 5, times 2?", ctx: { ownerId: "owner-1" }, ...extra });

  beforeEach(() => (calls.length = 0));

  test("plan -> tool -> observe -> final answer", async () => {
    const provider = script(
      { action: "tool", thought: "compute", tool: "calculator", args: { expression: "(18 - 5) * 2" } },
      { action: "final", thought: "done", answer: "26" }
    );
    const r = await run(provider);
    expect(r).toMatchObject({ status: "final", answer: "26", iterations: 2 });
    expect(calls).toEqual(["(18 - 5) * 2"]);
    // The tool result went back to the model as delimited, untrusted data.
    expect(provider.calls[1].messages[1].content).toMatch(/<tool_result>\n\{"result":26\}\n<\/tool_result>/);
  });

  test("a tool NOT on the allowlist is rejected by schema validation (then repaired)", async () => {
    const provider = script(
      { action: "tool", tool: "shell", args: { cmd: "rm -rf /" } },
      { action: "final", answer: "I can only use the listed tools." }
    );
    const r = await run(provider);
    expect(r.status).toBe("final");
    expect(r.steps.some((s) => s.tool === "shell")).toBe(false); // never executed
    expect(provider.calls[1].messages.at(-1).content).toMatch(/tool/); // repair feedback named the bad field
  });

  test("invalid tool ARGS -> error observation, the tool never runs, the loop continues", async () => {
    const provider = script(
      { action: "tool", tool: "calculator", args: { expr: "1+1" } },
      { action: "final", answer: "ok" }
    );
    const r = await run(provider);
    expect(calls).toEqual([]);
    expect(r.steps[0]).toMatchObject({ ok: false });
    expect(r.steps[0].observation).toMatch(/invalid arguments/);
  });

  test("tool errors (e.g. eval attempt) become observations, not crashes", async () => {
    const provider = script(
      { action: "tool", tool: "calculator", args: { expression: "process.exit()" } },
      { action: "final", answer: "cannot" }
    );
    const r = await run(provider);
    expect(r.steps[0].observation).toMatch(/only numbers/);
  });

  test("STOP: max iterations", async () => {
    let n = 0;
    const provider = createMockProvider({
      respond: () => JSON.stringify({ action: "tool", tool: "calculator", args: { expression: `${n++} + 1` } }),
    });
    const r = await run(provider, { maxIterations: 3 });
    expect(r).toMatchObject({ status: "max_iterations", answer: null, iterations: 3 });
  });

  test("STOP: the same tool call twice in a row = loop", async () => {
    const provider = script({ action: "tool", tool: "calculator", args: { expression: "1+1" } });
    const r = await run(provider);
    expect(r).toMatchObject({ status: "loop_detected", iterations: 2 });
    expect(calls).toEqual(["1+1"]);
  });

  test("per-tool timeout", async () => {
    const provider = script({ action: "tool", tool: "slow", args: {} }, { action: "final", answer: "gave up waiting" });
    const r = await run(provider);
    expect(r.steps[0].observation).toMatch(/timed out after 30ms/);
  });

  test("STOP: external abort (task timeout / cancel) ends the loop", async () => {
    const controller = new AbortController();
    let turns = 0;
    const provider = createMockProvider({
      respond: () => {
        turns += 1;
        if (turns === 2) controller.abort(new Error("task cancelled")); // cancelled mid-run
        return JSON.stringify({ action: "tool", tool: "calculator", args: { expression: `${turns} + 1` } });
      },
    });
    await expect(run(provider, { signal: controller.signal, maxIterations: 8 })).rejects.toThrow("task cancelled");
    expect(turns).toBe(2); // no further model calls after the abort
  });

  test("scope comes from the TASK, never from the model: ctx.ownerId reaches the tool", async () => {
    const provider = script({ action: "tool", tool: "echo_owner", args: { ownerId: "someone-else" } }, { action: "final", answer: "x" });
    const r = await run(provider);
    expect(r.steps[0].observation).toBe('{"ownerId":"owner-1"}');
  });
});
