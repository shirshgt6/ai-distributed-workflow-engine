import { createCircuitBreaker } from "../../src/ai/providers/circuitBreaker.js";
import { createFallbackProvider } from "../../src/ai/providers/fallback.js";
import { createMockProvider } from "../../src/ai/providers/mock.js";
import { ProviderError } from "../../src/ai/providers/errors.js";
import { estimateCostUsd } from "../../src/ai/observability.js";
import { loadConfig } from "../../src/config/env.js";

describe("circuit breaker", () => {
  let t = 0;
  const now = () => t;
  test("CLOSED -> OPEN after N failures -> HALF_OPEN after cooldown -> one trial -> CLOSED on success", () => {
    const b = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now });
    b.failure();
    b.failure();
    expect(b.state).toBe("CLOSED");
    b.failure();
    expect(b.state).toBe("OPEN");
    expect(b.allow()).toBe(false); // refused instantly
    t += 1000;
    expect(b.allow()).toBe(true); // the single trial
    expect(b.allow()).toBe(false); // everyone else still waits
    b.success();
    expect(b.state).toBe("CLOSED");
  });

  test("a failed trial re-opens the circuit", () => {
    const b = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now });
    b.failure();
    t += 1000;
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.state).toBe("OPEN");
  });

  test("a success resets the failure count", () => {
    const b = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now });
    b.failure();
    b.success();
    b.failure();
    expect(b.state).toBe("CLOSED");
  });
});

describe("fallback provider", () => {
  const down = (retryable = true) => createMockProvider({ name: "primary", respond: () => new ProviderError("boom", { provider: "primary", retryable }) });
  const up = (name = "secondary") => createMockProvider({ name, respond: () => '{"ok":true}' });
  const req = { model: "small-model", messages: [{ role: "user", content: "hi" }] };

  test("primary healthy -> primary answers, fallbackUsed false", async () => {
    const p = createFallbackProvider({ entries: [{ provider: up("primary") }, { provider: up() }] });
    expect(await p.chat(req)).toMatchObject({ provider: "primary", fallbackUsed: false });
  });

  test("primary down (retryable) -> secondary answers, with ITS model name", async () => {
    const secondary = up();
    const p = createFallbackProvider({ entries: [{ provider: down() }, { provider: secondary, mapModel: () => "hosted-model" }] });
    const r = await p.chat(req);
    expect(r).toMatchObject({ provider: "secondary", fallbackUsed: true, content: '{"ok":true}' });
    expect(secondary.calls[0].model).toBe("hosted-model");
  });

  test("NON-retryable error (400) is NOT hidden by falling back", async () => {
    const secondary = up();
    const p = createFallbackProvider({ entries: [{ provider: down(false) }, { provider: secondary }] });
    await expect(p.chat(req)).rejects.toMatchObject({ retryable: false });
    expect(secondary.calls).toHaveLength(0);
  });

  test("everyone down -> retryable error (so the task retries later with backoff)", async () => {
    const p = createFallbackProvider({ entries: [{ provider: down() }, { provider: down() }] });
    await expect(p.chat(req)).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(/All LLM providers failed/) });
  });

  test("an OPEN circuit skips the dead primary without calling it", async () => {
    const primary = down();
    const p = createFallbackProvider({ entries: [{ provider: primary }, { provider: up() }], breaker: { failureThreshold: 2, cooldownMs: 60_000 } });
    await p.chat(req);
    await p.chat(req);
    const before = primary.calls.length;
    const r = await p.chat(req);
    expect(primary.calls.length).toBe(before); // not even tried
    expect(r.fallbackUsed).toBe(true);
  });

  test("embeddings never fall back (a different model = a different vector space)", async () => {
    const secondary = up();
    const failingEmbedder = { name: "p", embed: async () => { throw new ProviderError("down", { provider: "p", retryable: true }); } };
    const p = createFallbackProvider({ entries: [{ provider: failingEmbedder }, { provider: secondary }] });
    await expect(p.embed({ model: "e", input: ["x"] })).rejects.toThrow("down");
    expect(secondary.calls.filter((c) => c.type === "embed")).toHaveLength(0);
  });
});

describe("cost estimation", () => {
  test("USD from a per-1M-token price table; unknown/local models cost 0", () => {
    const pricing = { "gpt-x": { inputPer1M: 0.15, outputPer1M: 0.6 } };
    expect(estimateCostUsd(pricing, "gpt-x", 1_000_000, 500_000)).toBeCloseTo(0.45);
    expect(estimateCostUsd(pricing, "qwen2.5:0.5b", 1000, 1000)).toBe(0);
  });

  test("LLM_PRICING_JSON is validated at boot", () => {
    const base = { MONGO_URI: "mongodb://x", REDIS_URL: "redis://x", JWT_ACCESS_SECRET: "a".repeat(32), JWT_REFRESH_SECRET: "b".repeat(32) };
    expect(loadConfig({ ...base, LLM_PRICING_JSON: '{"m":{"inputPer1M":1,"outputPer1M":2}}' }).llm.pricing).toEqual({ m: { inputPer1M: 1, outputPer1M: 2 } });
    expect(() => loadConfig({ ...base, LLM_PRICING_JSON: "not json" })).toThrow(/LLM_PRICING_JSON/);
    expect(loadConfig(base).llm.fallback).toBeNull(); // no secondary unless configured
  });
});
