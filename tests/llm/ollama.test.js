// REAL MODEL tests against a local Ollama. Not part of `npm test` / `test:all`.
//   ollama pull qwen2.5:0.5b && ollama pull nomic-embed-text
//   npm run test:llm
// A 0.5B-parameter model is small and sometimes wrong. These tests check the
// PLUMBING (real HTTP, JSON mode, validation/repair, embeddings), not model quality.
import { z } from "zod";
import { createOpenAICompatibleProvider } from "../../src/ai/providers/openaiCompatible.js";
import { generateStructured } from "../../src/ai/structured.js";

const provider = createOpenAICompatibleProvider({
  name: "ollama",
  baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:11434",
  timeoutMs: 120_000,
});
const MODEL = process.env.LLM_MODEL_SMALL ?? "qwen2.5:0.5b";

test("structured output from a real model passes schema validation (repairing if needed)", async () => {
  const schema = z.object({ sentiment: z.enum(["positive", "negative"]) });
  const r = await generateStructured({
    provider,
    model: MODEL,
    schema,
    system: "Classify the sentiment of the review.",
    user: "Absolutely love it, works perfectly!",
  });
  expect(["positive", "negative"]).toContain(r.data.sentiment);
  expect(r.usage.inputTokens).toBeGreaterThan(0);
  console.log(`[real model] ${JSON.stringify(r.data)} in ${r.attempts} attempt(s)`);
}, 120_000);

test("real embeddings: 768-dim vectors, and related texts are closer than unrelated ones", async () => {
  const { vectors } = await provider.embed({
    model: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
    input: ["How do I get a refund for my order?", "Refund policy for returned orders", "The weather is sunny today"],
  });
  const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
  expect(vectors[0]).toHaveLength(768);
  expect(cos(vectors[0], vectors[1])).toBeGreaterThan(cos(vectors[0], vectors[2]));
  console.log(`[real embeddings] refund~refund ${cos(vectors[0], vectors[1]).toFixed(3)} vs refund~weather ${cos(vectors[0], vectors[2]).toFixed(3)}`);
}, 120_000);

test("real classification + routing of a request", async () => {
  const { classifyTask } = await import("../../src/ai/classifier.js");
  const { routeTask } = await import("../../src/ai/router.js");
  const r = await classifyTask({
    provider,
    model: MODEL,
    request: "According to our company handbook, how many vacation days do new employees get?",
    fallback: false,
  });
  const route = routeTask(r.classification, { small: MODEL, large: MODEL });
  console.log(`[real classifier] ${JSON.stringify(r.classification)} (${r.attempts} attempt(s)) -> route ${route.mode}/${route.tier}`);
  expect(["direct", "rag", "agent"]).toContain(route.mode);
}, 180_000);
