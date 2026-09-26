import { z } from "zod";
import mongoose from "mongoose";
import { evaluateArithmetic } from "./calculator.js";
import { hasPermission, PERMISSIONS } from "../../auth/permissions.js";

/**
 * AGENT TOOLS: the COMPLETE list of things an agent can ever do.
 *
 * Every tool is:
 *   - read-only (no tool can write, delete, send or spend anything)
 *   - argument-validated with zod BEFORE it runs
 *   - permission-checked against the run owner's role
 *   - scoped to the run owner's data (ownerId comes from the task, NEVER
 *     from the model's arguments, so the model can't ask for someone else's data)
 *   - time-limited (per-tool timeout)
 *   - output-limited (truncated before going back into the prompt)
 * There is deliberately no shell, HTTP fetch, file access or code execution.
 *
 * @param {{ rag?, WorkflowExecution, Task }} deps
 */
export function createToolRegistry({ rag, WorkflowExecution, Task }) {
  const tools = {
    search_knowledge_base: {
      description: "Search the user's own knowledge base. Returns the most relevant text snippets.",
      schema: z.object({ query: z.string().min(1).max(300), topK: z.number().int().min(1).max(5).default(3) }),
      permission: PERMISSIONS.WORKFLOW_READ,
      timeoutMs: 20_000,
      async run({ query, topK }, ctx) {
        if (!rag) return { error: "knowledge base not configured" };
        const hits = await rag.retrieve({ ownerId: ctx.ownerId, query, k: topK, signal: ctx.signal });
        return hits.map((h) => ({ title: h.title, score: h.score, text: h.text.slice(0, 500) }));
      },
    },

    get_workflow_status: {
      description: "Get the status of one of the user's workflow executions and its tasks, by execution id.",
      schema: z.object({ executionId: z.string().refine((v) => mongoose.isValidObjectId(v), "must be an execution id") }),
      permission: PERMISSIONS.WORKFLOW_READ,
      timeoutMs: 5_000,
      async run({ executionId }, ctx) {
        // Ownership inside the query: someone else's execution = "not found".
        const execution = await WorkflowExecution.findOne({ _id: executionId, ownerId: ctx.ownerId }).lean();
        if (!execution) return { error: "execution not found" };
        const tasks = await Task.find({ executionId: execution._id }).select("key status attempt").lean();
        return { status: execution.status, tasks: tasks.map((t) => ({ key: t.key, status: t.status, attempt: t.attempt })) };
      },
    },

    calculator: {
      description: "Evaluate an arithmetic expression with + - * / % ^ and parentheses, e.g. (18 - 5) * 2.",
      schema: z.object({ expression: z.string().min(1).max(200) }),
      permission: null, // harmless
      timeoutMs: 1_000,
      async run({ expression }) {
        return { result: evaluateArithmetic(expression) };
      },
    },
  };
  return tools;
}

/**
 * The tools THIS agent run may use: (task allowlist) ∩ (registry) ∩ (what the
 * owner's role permits). Unknown names in the allowlist are an error: a typo
 * shouldn't silently shrink or widen what an agent can do.
 */
export function selectTools(registry, { allowlist, role }) {
  const names = allowlist ?? Object.keys(registry);
  const unknown = names.filter((n) => !registry[n]);
  if (unknown.length) throw new Error(`Unknown agent tool(s): ${unknown.join(", ")}`);
  const allowed = {};
  const denied = [];
  for (const name of names) {
    const tool = registry[name];
    if (tool.permission && !hasPermission(role, tool.permission)) denied.push(name);
    else allowed[name] = tool;
  }
  return { allowed, denied };
}
