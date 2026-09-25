import { computeBackoff, isRetryable, NonRetryableError } from "../../src/workers/retry.js";

describe("computeBackoff (exponential + full jitter)", () => {
  const max = () => 0.999999; // near the top of the jitter range
  const min = () => 0;

  test("the cap doubles per attempt: 1s, 2s, 4s, 8s", () => {
    expect([1, 2, 3, 4].map((a) => computeBackoff(a, 1000, { random: max }))).toEqual([999, 1999, 3999, 7999]);
  });

  test("never exceeds maxDelayMs, however many attempts", () => {
    expect(computeBackoff(30, 1000, { maxDelayMs: 60_000, random: max })).toBe(59_999);
  });

  test("jitter spreads retries between 0 and the cap", () => {
    expect(computeBackoff(3, 1000, { random: min })).toBe(0);
    const samples = Array.from({ length: 1000 }, () => computeBackoff(3, 1000));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThan(4000);
    // 1000 tasks failing together do NOT all retry at the same instant:
    expect(new Set(samples).size).toBeGreaterThan(500);
  });
});

describe("isRetryable", () => {
  test("transient by default; NonRetryableError or retryable:false opts out", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryable(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(true);
    expect(isRetryable(new NonRetryableError("card declined"))).toBe(false);
    expect(isRetryable(Object.assign(new Error("bad input"), { retryable: false }))).toBe(false);
  });
});
