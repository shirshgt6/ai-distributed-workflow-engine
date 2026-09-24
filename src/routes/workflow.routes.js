import { Router } from "express";
import { createWorkflowController } from "../controllers/workflow.controller.js";
import { validate } from "../middleware/validate.js";
import { requirePermission } from "../middleware/authorize.js";
import { PERMISSIONS } from "../auth/permissions.js";
import {
  createWorkflowSchema,
  listWorkflowsSchema,
  updateWorkflowSchema,
  workflowIdSchema,
} from "../workflow/workflow.schemas.js";

// authenticate (401) -> requirePermission (403, action level) -> validate (400)
// -> controller -> service (ownership, 404: object level)
export function createWorkflowRouter({ workflowService, authenticate }) {
  const c = createWorkflowController(workflowService);
  const router = Router();

  router.use("/workflows", authenticate);

  router.post("/workflows", requirePermission(PERMISSIONS.WORKFLOW_CREATE), validate(createWorkflowSchema), c.create);
  router.get("/workflows", requirePermission(PERMISSIONS.WORKFLOW_READ), validate(listWorkflowsSchema), c.list);
  router.get("/workflows/:id", requirePermission(PERMISSIONS.WORKFLOW_READ), validate(workflowIdSchema), c.get);
  // Editing a definition is the same capability as creating one.
  router.put("/workflows/:id", requirePermission(PERMISSIONS.WORKFLOW_CREATE), validate(updateWorkflowSchema), c.update);

  return router;
}
