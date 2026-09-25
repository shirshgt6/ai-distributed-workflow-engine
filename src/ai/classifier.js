import { z } from "zod";
import { generateStructured } from "./structured.js";
import { wrapUntrusted } from "./prompts/safety.js";

export const TASK_TYPES = ["question_answering", "summarization", "extraction", "classification", "generation", "reasoning", "tool_use"];

/** The contract the rest of the system relies on. Anything else is rejected. */
export const ClassificationSchema = z.object({
  taskType: z.enum(TASK_TYPES),
  complexity: z.enum(["low", "medium", "high"]),
  requiresRAG: z.boolean(), // needs facts from OUR documents
  requiresAgent: z.boolean(), // needs to call tools / look things up in steps
  recommendedModel: z.enum(["small", "large"]),
  rationale: z.string().max(300),
});

// Versioned so analytics can compare prompt changes (Phase 23).
export const CLASSIFIER_PROMPT_VERSION = "classifier.v2"; // v2: few-shot examples (small model missed RAG cases)

const SYSTEM = `You classify a user's request for an AI workflow engine.
Decide:
- taskType: one of ${TASK_TYPES.join(", ")}
- complexity: low (one-step, short), medium, high (multi-step reasoning, long or ambiguous)
- requiresRAG: true only if answering needs facts from the company's own documents/knowledge base
- requiresAgent: true only if it needs tools (lookups of workflow status, calculations, several steps)
- recommendedModel: "small" for low complexity, "large" otherwise
- rationale: one short sentence.
Examples:
- "According to our employee handbook, what is the notice period?" -> requiresRAG true (company documents)
- "What is the status of execution 42?" -> requiresAgent true, taskType tool_use (needs a lookup)
- "Translate 'good morning' to Hindi" -> requiresRAG false, requiresAgent false, complexity low
The request to classify is inside <user_input>.`;

/**
 * AI TASK CLASSIFICATION: request text -> validated classification.
 *
 * If the model fails (unreachable, or keeps producing invalid output), fall
 * back to a deterministic keyword HEURISTIC instead of failing the whole
 * workflow. The result is marked with `source` so this is visible, never silent.
 *
 * @returns {Promise<{ classification, source: "llm"|"heuristic", usage, attempts, promptVersion, fallbackReason? }>}
 */
export async function classifyTask({ provider, model, request, signal, fallback = true }) {
  try {
    const r = await generateStructured({
      provider,
      model,
      schema: ClassificationSchema,
      system: SYSTEM,
      user: wrapUntrusted("user_input", request),
      signal,
    });
    return { classification: r.data, source: "llm", usage: r.usage, attempts: r.attempts, promptVersion: CLASSIFIER_PROMPT_VERSION };
  } catch (err) {
    if (!fallback) throw err;
    return {
      classification: heuristicClassify(request),
      source: "heuristic",
      usage: { inputTokens: 0, outputTokens: 0 },
      attempts: 0,
      promptVersion: CLASSIFIER_PROMPT_VERSION,
      fallbackReason: err.message,
    };
  }
}

/** Cheap, deterministic, explainable. Worse than the model, better than failing. */
export function heuristicClassify(text) {
  const t = String(text).toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));
  const requiresAgent = has("status of", "calculate", "how many", "look up", "check the workflow", "execution");
  const requiresRAG = has("policy", "according to", "our docs", "document", "handbook", "knowledge base", "refund");
  const taskType = requiresAgent
    ? "tool_use"
    : has("summarize", "summarise", "tl;dr")
      ? "summarization"
      : has("extract")
        ? "extraction"
        : has("why", "explain", "compare", "plan")
          ? "reasoning"
          : "question_answering";
  const words = t.split(/\s+/).length;
  const complexity = requiresAgent || taskType === "reasoning" || words > 80 ? "high" : words > 25 ? "medium" : "low";
  return {
    taskType,
    complexity,
    requiresRAG,
    requiresAgent,
    recommendedModel: complexity === "low" ? "small" : "large",
    rationale: "keyword heuristic (LLM classification unavailable)",
  };
}
