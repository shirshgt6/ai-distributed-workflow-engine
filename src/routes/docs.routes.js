import { Router } from "express";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import swaggerUi from "swagger-ui-express";

// The OpenAPI spec is hand-written (src/docs/openapi.yaml). A test compares it
// with the routes Express actually registers, so it can't silently drift.
export const openapiSpec = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));

export function createDocsRouter() {
  const router = Router();
  router.get("/openapi.json", (req, res) => res.json(openapiSpec));
  router.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec, { customSiteTitle: "Workflow Engine API" }));
  return router;
}
