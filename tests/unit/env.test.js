import { loadConfig } from "../../src/config/env.js";

const valid = {
  MONGO_URI: "mongodb://localhost:27018/test",
  REDIS_URL: "redis://localhost:6380",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
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
      auth: { accessTtl: "15m", refreshTtl: "7d", bcryptCost: 12 },
    });
  });

  test("coerces numeric strings", () => {
    expect(loadConfig({ ...valid, PORT: "8080" }).port).toBe(8080);
  });

  test("returns a frozen object (read-only after boot)", () => {
    const config = loadConfig(valid);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.mongo)).toBe(true);
    expect(Object.isFrozen(config.auth)).toBe(true);
  });

  test("reports EVERY invalid variable in one error", () => {
    const message = errorMessageOf(() => loadConfig({ PORT: "abc" }));
    for (const name of ["PORT", "MONGO_URI", "REDIS_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]) {
      expect(message).toContain(name);
    }
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

  describe("JWT secrets", () => {
    test("must be at least 32 characters", () => {
      expect(() => loadConfig({ ...valid, JWT_ACCESS_SECRET: "short" })).toThrow(/JWT_ACCESS_SECRET/);
    });

    test("access and refresh secrets must differ", () => {
      const same = "s".repeat(40);
      expect(() => loadConfig({ ...valid, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same })).toThrow(
        /JWT_REFRESH_SECRET: must differ/
      );
    });

    test("placeholder secrets are allowed locally but refused in production", () => {
      const placeholders = {
        ...valid,
        JWT_ACCESS_SECRET: "change-me-access-secret-at-least-32-chars",
        JWT_REFRESH_SECRET: "change-me-refresh-secret-at-least-32-chars",
      };
      expect(() => loadConfig(placeholders)).not.toThrow();
      expect(() => loadConfig({ ...placeholders, NODE_ENV: "production" })).toThrow(/placeholder JWT secrets/);
    });
  });

  test("BCRYPT_COST is bounded", () => {
    expect(() => loadConfig({ ...valid, BCRYPT_COST: "3" })).toThrow(/BCRYPT_COST/);
    expect(() => loadConfig({ ...valid, BCRYPT_COST: "16" })).toThrow(/BCRYPT_COST/);
  });
});
