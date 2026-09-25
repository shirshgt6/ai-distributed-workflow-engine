import { z } from "zod";
import { classifyTask } from "../ai/classifier.js";
import { routeTask } from "../ai/router.js";
import { generateStructured } from "../ai/structured.js";
import { wrapUntrusted } from "../ai/prompts/safety.js";
import { NonRetryableError } from "../workers/retry.js";

/**
 * AI task handlers. Each is an ordinary workflow task: it gets
 * { config, input, parents, attempt, ownerId, signal } and returns JSON, so AI steps
 * compose with every engine feature (dependencies, retries, timeouts,
 * cancellation, events) without special cases.
 *
 * ProviderError.retryable flows straight into the engine's retry decision:
 * an Ollama timeout is retried with backoff, a 400 fails immediately.
 *
 * @param {{ provider, models: { small: string, large: string, embedding: string }, logger, rag? }} deps
 */
export function createAiHandlers({ provider, models, rag }) {
  /** The request text: config.text, else input[config.inputField ?? "text"]. */
  function requestText({ config, input }) {
    const text = config.text ?? input?.[config.inputField ?? "text"];
    if (typeof text !== "string" || !text.trim()) {
      throw new NonRetryableError('ai task needs a request: set config.text or pass { "text": "..." } as run input');
    }
    return text.slice(0, 8000);
  }

  return {
    /** Classify the request. Output: { classification, source, usage, attempts, promptVersion }. */
    "ai.classify": async (ctx) => {
      return classifyTask({ provider, model: models.small, request: requestText(ctx), signal: ctx.signal });
    },

    /**
     * Classify + route. Reuses a parent's classification if one exists (no
     * double LLM call). Output: { classification, route }.
     */
    "ai.route": async (ctx) => {
      const fromParent = Object.values(ctx.parents ?? {}).find((p) => p?.classification);
      const classified = fromParent ?? (await classifyTask({ provider, model: models.small, request: requestText(ctx), signal: ctx.signal }));
      return { classification: classified.classification, source: classified.source, route: routeTask(classified.classification, models) };
    },

    /**
     * Answer from the run OWNER's knowledge base with citations (RAG).
     * Model: parent route's model if it routed to "rag", else config.tier, else small.
     * Output: { answer, citations[], grounded, retrieved, usage, model }.
     */
    "ai.rag": async (ctx) => {
      if (!rag) throw new NonRetryableError("RAG is not configured on this worker");
      const route = Object.values(ctx.parents ?? {}).find((p) => p?.route)?.route;
      const model = route?.mode === "rag" ? route.model : (models[ctx.config.tier ?? "small"] ?? models.small);
      return rag.answer({ ownerId: ctx.ownerId, question: requestText(ctx), model, signal: ctx.signal });
    },

    /**
     * Answer the request directly with an LLM. The model comes from a parent
     * route if present (so routing actually decides), else config.tier, else small.
     * Output: { answer, model, usage }.
     */
    "ai.generate": async (ctx) => {
      const route = Object.values(ctx.parents ?? {}).find((p) => p?.route)?.route;
      if (route && route.mode !== "direct") {
        throw new NonRetryableError(`ai.generate can only serve "direct" routes; this request was routed to "${route.mode}"`);
      }
      const model = route?.model ?? models[ctx.config.tier ?? "small"] ?? models.small;
      const r = await generateStructured({
        provider,
        model,
        schema: z.object({ answer: z.string().min(1).max(4000) }),
        system: "Answer the user's request helpfully and concisely.",
        user: wrapUntrusted("user_input", requestText(ctx)),
        signal: ctx.signal,
      });
      return { answer: r.data.answer, model, usage: r.usage };
    },
  };
}
