import { z } from "zod";
import { NonRetryableError } from "../workers/retry.js";
import { UNTRUSTED_DATA_RULE } from "./prompts/safety.js";

export class StructuredOutputError extends NonRetryableError {
  constructor(message, { attempts, lastOutput, issues }) {
    super(message);
    this.name = "StructuredOutputError";
    this.attempts = attempts;
    this.lastOutput = lastOutput;
    this.issues = issues;
  }
}

/** Models often wrap JSON in ```json fences or add a sentence around it. */
export function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * STRUCTURED OUTPUT with VALIDATION and REPAIR.
 *
 *   ask (JSON mode + the JSON Schema in the system prompt)
 *     -> parse -> validate with zod
 *     -> invalid? send the model its own output + the exact errors, ask it to
 *        fix them (REPAIR), up to maxRepairs times
 *     -> still invalid? StructuredOutputError (non-retryable for the task:
 *        the same prompt would fail the same way)
 *
 * Why validate when JSON mode exists: JSON mode guarantees *syntax*, not the
 * *shape* we need (field names, enums, types). Downstream code must never
 * receive an object it didn't validate. That's also a prompt-injection defence:
 * even a manipulated model can only return something our schema allows.
 *
 * @template T
 * @param {{
 *   provider, model: string, schema: import('zod').ZodType<T>,
 *   system: string, user: string, maxRepairs?: number, signal?: AbortSignal,
 *   onCall?: (call: { attempt: number, usage, latencyMs, ok: boolean, error?: string }) => void
 * }} params
 * @returns {Promise<{ data: T, attempts: number, usage: { inputTokens: number, outputTokens: number } }>}
 */
export async function generateStructured({ provider, model, schema, system, user, maxRepairs = 2, signal, onCall }) {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const messages = [
    {
      role: "system",
      content: `${system}\n\n${UNTRUSTED_DATA_RULE}\n\nRespond with ONE JSON object only, no prose, matching this JSON Schema:\n${jsonSchema}`,
    },
    { role: "user", content: user },
  ];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let lastOutput = "";
  let lastIssues = [];

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const res = await provider.chat({ model, messages, temperature: 0, json: true, signal });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    lastOutput = res.content;

    let problem;
    try {
      const parsed = schema.safeParse(extractJson(res.content));
      if (parsed.success) {
        onCall?.({ attempt, usage: res.usage, latencyMs: res.latencyMs, ok: true });
        return { data: parsed.data, attempts: attempt, usage };
      }
      lastIssues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      problem = `It does not match the schema:\n- ${lastIssues.join("\n- ")}`;
    } catch (err) {
      lastIssues = [`invalid JSON: ${err.message}`];
      problem = `It is not valid JSON (${err.message}).`;
    }
    onCall?.({ attempt, usage: res.usage, latencyMs: res.latencyMs, ok: false, error: problem });

    // REPAIR: show the model exactly what was wrong with its own answer.
    messages.push(
      { role: "assistant", content: res.content },
      { role: "user", content: `Your previous reply was invalid. ${problem}\nReturn ONLY the corrected JSON object.` }
    );
  }

  throw new StructuredOutputError(`Model output failed validation after ${maxRepairs + 1} attempt(s)`, {
    attempts: maxRepairs + 1,
    lastOutput: lastOutput.slice(0, 500),
    issues: lastIssues,
  });
}
