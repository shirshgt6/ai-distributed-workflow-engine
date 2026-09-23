import express from "express";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/config/logger.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { AppError } from "../../src/utils/errors.js";

const logger = createLogger({ level: "silent" });
const up = async () => {};
const down = async () => {
  throw new Error("connect ECONNREFUSED 10.0.0.5:27017");
};
const hang = () => new Promise(() => {});

function buildApp(overrides = {}) {
  return createApp({ logger, checks: { mongo: up, redis: up }, ...overrides });
}

describe("GET /health (liveness)", () => {
  test("200 even when dependencies are down", async () => {
    const app = buildApp({ checks: { mongo: down, redis: down } });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("GET /ready (readiness)", () => {
  test("200 when every dependency is up", async () => {
    const res = await request(buildApp()).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks.mongo.status).toBe("up");
    expect(res.body.checks.redis.status).toBe("up");
  });

  test("503 when any dependency is down, without leaking the raw error", async () => {
    const res = await request(buildApp({ checks: { mongo: down, redis: up } })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.mongo.status).toBe("down");
    expect(res.body.checks.redis.status).toBe("up");
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
  });

  test("a HUNG dependency is reported down instead of hanging the probe", async () => {
    const res = await request(buildApp({ checks: { mongo: hang, redis: up } })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.mongo.status).toBe("down");
  }, 5000);

  test("503 shutting_down during graceful shutdown", async () => {
    const res = await request(buildApp({ isShuttingDown: () => true })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("shutting_down");
  });
});

describe("request id", () => {
  test("generates one when absent", async () => {
    const res = await request(buildApp()).get("/health");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("propagates a safe incoming id", async () => {
    const res = await request(buildApp()).get("/health").set("X-Request-Id", "upstream-abc.123");
    expect(res.headers["x-request-id"]).toBe("upstream-abc.123");
  });

  test("replaces an unsafe incoming id", async () => {
    const res = await request(buildApp()).get("/health").set("X-Request-Id", "bad id with spaces");
    expect(res.headers["x-request-id"]).not.toBe("bad id with spaces");
  });
});

describe("error handling", () => {
  test("unknown route -> 404 in the standard error shape", async () => {
    const res = await request(buildApp()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  test("malformed JSON -> 400 INVALID_JSON", async () => {
    const res = await request(buildApp())
      .post("/anything")
      .set("Content-Type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  test("oversized body -> 413 PAYLOAD_TOO_LARGE", async () => {
    const res = await request(buildApp({ bodyLimit: "1kb" }))
      .post("/anything")
      .send({ data: "x".repeat(5000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("security headers are set and the framework is not advertised", async () => {
    const res = await request(buildApp()).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  // Mini app so we can throw arbitrary errors through the real handler.
  function throwingApp(error) {
    const app = express();
    app.use((req, _res, next) => {
      req.id = "req-1";
      next();
    });
    app.get("/boom", async () => {
      throw error; // Express 5 forwards async rejections to errorHandler
    });
    app.use(errorHandler);
    return app;
  }

  test("AppError keeps its status, code and message", async () => {
    const res = await request(throwingApp(new AppError("Workflow is paused", { statusCode: 409, code: "CONFLICT" }))).get(
      "/boom"
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "CONFLICT", message: "Workflow is paused", requestId: "req-1" });
  });

  test("unexpected errors become a generic 500 (no internals leaked)", async () => {
    const res = await request(throwingApp(new Error("db password is hunter2"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });
});
