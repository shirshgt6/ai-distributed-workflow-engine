// The OpenAPI spec must describe exactly the routes Express registers.
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/config/logger.js";
import { createTokenService } from "../../src/auth/tokens.js";
import { openapiSpec } from "../../src/routes/docs.routes.js";
import request from "supertest";

const logger = createLogger({ level: "silent" });
const tokens = createTokenService({ accessSecret: "a".repeat(40), refreshSecret: "b".repeat(40), accessTtl: "15m", refreshTtl: "7d" });
const fake = new Proxy({}, { get: () => () => {} }); // services aren't called: we only list routes
const app = createApp({
  logger,
  auth: { authService: fake, tokens },
  workflowService: fake,
  executionService: fake,
  admin: { listWorkers: async () => [] },
  knowledge: { rag: fake, KnowledgeDocument: fake },
  approvals: { engine: fake, ApprovalRequest: fake },
  analyticsService: fake,
});

/** Walk Express 5's router tree: "METHOD /path" for every route. */
function registeredRoutes(router) {
  const out = new Set();
  for (const layer of router.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) out.add(`${m.toUpperCase()} ${layer.route.path}`);
    } else if (layer.handle?.stack) {
      for (const r of registeredRoutes(layer.handle)) out.add(r);
    }
  }
  return out;
}

const HTTP = ["get", "post", "put", "patch", "delete"];
const documented = new Set(
  Object.entries(openapiSpec.paths).flatMap(([path, ops]) =>
    Object.keys(ops).filter((m) => HTTP.includes(m)).map((m) => `${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`)
  )
);
const actual = [...registeredRoutes(app.router)].filter((r) => !r.endsWith("/openapi.json"));

test("every registered route is documented in openapi.yaml", () => {
  expect(actual.filter((r) => !documented.has(r))).toEqual([]);
});

test("every documented route actually exists", () => {
  expect([...documented].filter((r) => !actual.includes(r))).toEqual([]);
});

test("GET /openapi.json serves the spec; GET /docs serves Swagger UI", async () => {
  const spec = await request(app).get("/openapi.json");
  expect(spec.status).toBe(200);
  expect(spec.body.openapi).toBe("3.1.0");
  const ui = await request(app).get("/docs/");
  expect(ui.status).toBe(200);
  expect(ui.text).toContain("swagger-ui");
});

test("the strict CSP still applies to the API (relaxed only for /docs)", async () => {
  expect((await request(app).get("/health")).headers["content-security-policy"]).toBeDefined();
  expect((await request(app).get("/docs/")).headers["content-security-policy"]).toBeUndefined();
});
