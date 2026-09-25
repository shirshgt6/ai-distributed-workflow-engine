/**
 * AI MODEL ROUTER: classification -> which pipeline and which model.
 *
 * Deliberately RULE-BASED, not another LLM call: rules are free, instant,
 * deterministic, unit-testable and explainable ("why did this go to the
 * large model?" -> the rule that fired). An LLM router adds cost and latency
 * and can be wrong in ways you can't test exhaustively.
 *
 * Rules, first match wins:
 *   1. needs tools              -> AGENT  (large model: multi-step tool use needs the stronger one)
 *   2. needs our documents      -> RAG    (model by complexity)
 *   3. high complexity / reasoning -> DIRECT, large model
 *   4. everything else          -> DIRECT, small model (cheaper, faster)
 *
 * Cost vs latency vs quality: most traffic is simple, so defaulting to the
 * small model and escalating only when the classification says so saves
 * cost and latency on the common path while keeping quality where it matters.
 *
 * @param {import('zod').infer<typeof import('./classifier.js').ClassificationSchema>} c
 * @param {{ small: string, large: string }} models
 * @returns {{ mode: "direct"|"rag"|"agent", model: string, tier: "small"|"large", rule: string }}
 */
export function routeTask(c, models) {
  const pick = (tier, mode, rule) => ({ mode, tier, model: models[tier], rule });
  if (c.requiresAgent) return pick("large", "agent", "requires-tools");
  if (c.requiresRAG) return pick(c.complexity === "low" ? "small" : "large", "rag", "requires-knowledge");
  if (c.complexity === "high" || c.taskType === "reasoning") return pick("large", "direct", "high-complexity");
  return pick(c.recommendedModel === "large" && c.complexity !== "low" ? "large" : "small", "direct", "default-small");
}
