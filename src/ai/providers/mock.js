import { createHash } from "node:crypto";

/**
 * MOCK PROVIDER: same interface as the real one, fully deterministic.
 * Used by tests and by LLM_PROVIDER=mock (demo without a model).
 *
 * chat: `respond(request, callIndex)` decides the reply. It may return a
 * string (the content), an Error to throw, or { content, usage }.
 * embed: a bag-of-words hashing embedding. Texts sharing words get similar
 * vectors, which is enough to exercise RAG retrieval realistically in tests
 * (it is NOT a semantic model; synonyms don't match).
 *
 * @param {{ name?: string, respond?: Function, dims?: number }} [options]
 */
export function createMockProvider({ name = "mock", respond = () => "{}", dims = 64 } = {}) {
  const calls = [];

  function embedOne(text) {
    const v = new Array(dims).fill(0);
    for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const h = createHash("md5").update(word).digest();
      v[h[0] % dims] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  return {
    name,
    calls,
    dims,

    async chat(request) {
      const index = calls.length;
      calls.push({ type: "chat", ...request });
      const out = await respond(request, index);
      if (out instanceof Error) throw out;
      const content = typeof out === "string" ? out : out.content;
      const words = (s) => String(s).split(/\s+/).length;
      return {
        content,
        model: request.model,
        usage: out.usage ?? {
          inputTokens: request.messages.reduce((n, m) => n + words(m.content), 0),
          outputTokens: words(content),
        },
        latencyMs: 1,
      };
    },

    async embed({ model, input }) {
      calls.push({ type: "embed", model, input });
      return {
        vectors: input.map(embedOne),
        model,
        usage: { inputTokens: input.join(" ").split(/\s+/).length },
        latencyMs: 1,
      };
    },
  };
}
