import { withTimeout, TimeoutError } from "../../src/utils/withTimeout.js";

const sleep = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe("withTimeout", () => {
  test("resolves with the value when the promise wins", async () => {
    await expect(withTimeout(sleep(5, "done"), 200)).resolves.toBe("done");
  });

  test("rejects with TimeoutError when the timer wins", async () => {
    await expect(withTimeout(sleep(200), 10, "slow thing")).rejects.toThrow(TimeoutError);
    await expect(withTimeout(sleep(200), 10, "slow thing")).rejects.toThrow("slow thing timed out after 10ms");
  });

  test("propagates the original rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 100)).rejects.toThrow("boom");
  });
});
