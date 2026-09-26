import { z } from "zod";
import { classifyTask } from "../ai/classifier.js";
import { routeTask } from "../ai/router.js";
import { generateStructured } from "../ai/structured.js";
import { wrapUntrusted } from "../ai/prompts/safety.js";
import { NonRetryableError } from "../workers/retry.js";
import { runAgent } from "../ai/agent/agent.js";
import { selectTools } from "../ai/agent/tools.js";

/**
 * AI task handlers. Each is an ordinary workflow task: it gets
 * { config, input, parents, attempt, ownerId, signal } and returns JSON, so AI steps
 * compose with every engine feature (dependencies, retries, timeouts,
 * cancellation, events) without special cases.
 *
 * ProviderError.retryable flows straight into the engine's retry decision:
 * an Ollama timeout is retried with backoff, a 400 fails immediately.
 *
 * @param {{ provider, models: { small: string, large: string, embedding: string }, logger, rag?,
 *           tools?: object, getUserRole?: (userId: string) => Promise<string|null> }} deps
 */
export function createAiHandlers({ provider, models, rag, tools, getUserRole }) {
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
    /**
     * CONTROLLED AGENT. config: { tools?: string[] (allowlist), maxIterations?: 1-8 }.
     * Tools = allowlist ∩ registry ∩ what the run OWNER's role permits.
     * Output: { answer, iterations, steps[], deniedTools[], usage, model }.
     * An agent that stops without an answer (max iterations / loop) fails the
     * task, non-retryably: re-running the same goal would likely do the same.
     */
    "ai.agent": async (ctx) => {
      if (!tools || !getUserRole) throw new NonRetryableError("Agent tools are not configured on this worker");
      const role = await getUserRole(ctx.ownerId);
      if (!role) throw new NonRetryableError("Run owner no longer exists");
      let selection;
      try {
        selection = selectTools(tools, { allowlist: ctx.config.tools, role });
      } catch (err) {
        throw new NonRetryableError(err.message);
      }
      if (Object.keys(selection.allowed).length === 0) {
        throw new NonRetryableError(`No permitted tools for role "${role}" (denied: ${selection.denied.join(", ")})`);
      }
      const route = Object.values(ctx.parents ?? {}).find((p) => p?.route)?.route;
      const model = route?.mode === "agent" ? route.model : (models[ctx.config.tier ?? "large"] ?? models.large);
      const maxIterations = Math.min(Math.max(Number(ctx.config.maxIterations) || 5, 1), 8);

      const result = await runAgent({
        provider,
        model,
        tools: selection.allowed,
        goal: requestText(ctx),
        ctx: { ownerId: ctx.ownerId },
        maxIterations,
        signal: ctx.signal,
      });
      if (result.status !== "final") {
        const err = new NonRetryableError(`Agent stopped without an answer: ${result.status}`);
        err.details = result.steps;
        throw err;
      }
      return { answer: result.answer, iterations: result.iterations, steps: result.steps, deniedTools: selection.denied, usage: result.usage, model };
    },

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
