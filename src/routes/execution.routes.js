import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { createExecutionController } from "../controllers/execution.controller.js";
import { validate } from "../middleware/validate.js";
import { requirePermission } from "../middleware/authorize.js";
import { PERMISSIONS } from "../auth/permissions.js";

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), { message: "must be a valid id" });

const runSchema = {
  params: z.object({ id: objectId }),
  // `input` is made available to every task handler of this run.
  body: z.object({ input: z.record(z.string(), z.unknown()).default({}) }),
};
const executionIdSchema = { params: z.object({ id: objectId }) };

export function createExecutionRouter({ executionService, authenticate }) {
  const c = createExecutionController(executionService);
  const router = Router();

  router.post(
    "/workflows/:id/run",
    authenticate,
    requirePermission(PERMISSIONS.WORKFLOW_RUN),
    validate(runSchema),
    c.run
  );
  router.get(
    "/executions/:id",
    authenticate,
    requirePermission(PERMISSIONS.WORKFLOW_READ),
    validate(executionIdSchema),
    c.get
  );

  return router;
}
