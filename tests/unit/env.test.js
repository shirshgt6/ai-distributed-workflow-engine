import { loadConfig } from "../../src/config/env.js";

const valid = {
  MONGO_URI: "mongodb://localhost:27018/test",
  REDIS_URL: "redis://localhost:6380",
};

// Unlike a bare try/catch, this FAILS the test if fn does not throw.
function errorMessageOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  throw new Error("expected function to throw, but it did not");
}

describe("loadConfig", () => {
  test("applies defaults for optional variables", () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      env: "development",
      isProduction: false,
      port: 4000,
      logLevel: "info",
      bodyLimit: "100kb",
      shutdownTimeoutMs: 10000,
      mongo: { uri: valid.MONGO_URI },
      redis: { url: valid.REDIS_URL },
    });
  });

  test("coerces numeric strings", () => {
    expect(loadConfig({ ...valid, PORT: "8080" }).port).toBe(8080);
  });

  test("returns a frozen object (read-only after boot)", () => {
    const config = loadConfig(valid);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.mongo)).toBe(true);
  });

  test("reports EVERY invalid variable in one error", () => {
    const message = errorMessageOf(() => loadConfig({ PORT: "abc" }));
    expect(message).toContain("PORT");
    expect(message).toContain("MONGO_URI");
    expect(message).toContain("REDIS_URL");
  });

  test("rejects malformed connection strings", () => {
    expect(() => loadConfig({ ...valid, REDIS_URL: "localhost:6379" })).toThrow(/REDIS_URL/);
    expect(() => loadConfig({ ...valid, MONGO_URI: "http://x" })).toThrow(/MONGO_URI/);
  });

  test("never echoes variable VALUES in the error (they may be secrets)", () => {
    const secretLooking = "redis-super-secret-value";
    const message = errorMessageOf(() => loadConfig({ ...valid, REDIS_URL: secretLooking }));
    expect(message).toContain("REDIS_URL");
    expect(message).not.toContain(secretLooking);
  });

  test("rejects unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: "prod" })).toThrow(/NODE_ENV/);
  });
});
