import { z } from "zod";
import { generateStructured } from "../structured.js";
import { wrapUntrusted } from "../prompts/safety.js";
import { withTimeout } from "../../utils/withTimeout.js";

export const AGENT_PROMPT_VERSION = "agent.v1";
const MAX_OBSERVATION_CHARS = 2000;

/**
 * CONTROLLED AGENT LOOP.
 *
 * An LLM call answers once. An AGENT loops: think -> pick a tool -> we run it ->
 * show the result -> think again ... until it gives a final answer.
 *
 *   ┌─► ask model (structured: {action:"tool",tool,args} | {action:"final",answer})
 *   │      tool name must be in the ALLOWLIST (enum in the schema; others fail validation)
 *   │   validate args with the tool's zod schema   (invalid -> error observation, no run)
 *   │   run tool with a per-tool timeout            (error  -> error observation)
 *   └── append result as <tool_result> (untrusted, truncated)
 *
 * STOPPING CONDITIONS (any one ends the run):
 *   final answer | maxIterations reached | same tool+args twice in a row
 *   (loop) | overall timeout | external abort (task timeout / cancel)
 *
 * The model never executes anything itself. It only PROPOSES a tool call;
 * our code decides whether that call is allowed, valid and in scope.
 *
 * @returns {Promise<{ status: "final"|"max_iterations"|"loop_detected", answer: string|null, steps: object[], usage, iterations }>}
 */
export async function runAgent({ provider, model, tools, goal, ctx, maxIterations = 5, timeoutMs = 60_000, signal }) {
  const names = Object.keys(tools);
  if (names.length === 0) throw new Error("agent has no allowed tools");

  const Step = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("tool"),
      thought: z.string().max(500).default(""),
      tool: z.enum(names), // the allowlist, enforced by validation
      args: z.record(z.string(), z.unknown()).default({}),
    }),
    z.object({ action: z.literal("final"), thought: z.string().max(500).default(""), answer: z.string().min(1).max(3000) }),
  ]);

  const toolDocs = names
    .map((n) => `- ${n}: ${tools[n].description} Args JSON Schema: ${JSON.stringify(z.toJSONSchema(tools[n].schema))}`)
    .join("\n");
  const system =
    "You are an assistant that can use tools. Each turn, reply with exactly one JSON object:\n" +
    '  {"action":"tool","thought":"...","tool":"<name>","args":{...}}  to call a tool, or\n' +
    '  {"action":"final","thought":"...","answer":"..."}  when you can answer.\n' +
    `Available tools (you may use ONLY these):\n${toolDocs}\n` +
    "Use tool results to answer. Do not call the same tool with the same arguments twice.";

  const deadline = AbortSignal.timeout(timeoutMs);
  const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const transcript = [`Goal:\n${wrapUntrusted("user_input", goal)}`];
  const steps = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let lastCallKey = null;

  for (let i = 1; i <= maxIterations; i++) {
    if (runSignal.aborted) throw runSignal.reason ?? new Error("agent aborted");

    const { data: step, usage: u } = await generateStructured({
      provider,
      model,
      schema: Step,
      system,
      user: transcript.join("\n\n"),
      signal: runSignal,
    });
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;

    if (step.action === "final") {
      steps.push({ type: "final", thought: step.thought });
      return { status: "final", answer: step.answer, steps, usage, iterations: i };
    }

    // LOOP GUARD: the same call twice in a row can't produce new information.
    const callKey = `${step.tool}:${JSON.stringify(step.args)}`;
    if (callKey === lastCallKey) {
      steps.push({ type: "stopped", reason: "repeated identical tool call", tool: step.tool });
      return { status: "loop_detected", answer: null, steps, usage, iterations: i };
    }
    lastCallKey = callKey;

    const tool = tools[step.tool];
    const parsedArgs = tool.schema.safeParse(step.args);
    let observation;
    let ok = false;
    if (!parsedArgs.success) {
      observation = { error: `invalid arguments: ${parsedArgs.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}` };
    } else {
      try {
        observation = await withTimeout(tool.run(parsedArgs.data, { ...ctx, signal: runSignal }), tool.timeoutMs, `tool ${step.tool}`);
        ok = !observation?.error;
      } catch (err) {
        observation = { error: err.message };
      }
    }
    const text = JSON.stringify(observation).slice(0, MAX_OBSERVATION_CHARS);
    steps.push({ type: "tool", tool: step.tool, args: parsedArgs.success ? parsedArgs.data : step.args, ok, observation: text, thought: step.thought });
    transcript.push(
      `Step ${i}: you called ${step.tool} with ${JSON.stringify(step.args)}.\nResult:\n${wrapUntrusted("tool_result", text)}`
    );
  }

  steps.push({ type: "stopped", reason: `max iterations (${maxIterations}) reached` });
  return { status: "max_iterations", answer: null, steps, usage, iterations: maxIterations };
}
