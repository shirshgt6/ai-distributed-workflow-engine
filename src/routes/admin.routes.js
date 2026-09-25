import { Router } from "express";
import { requirePermission } from "../middleware/authorize.js";
import { PERMISSIONS } from "../auth/permissions.js";

/** Operational endpoints for admins. */
export function createAdminRouter({ authenticate, listWorkers }) {
  const router = Router();

  // Worker registry: ACTIVE (heartbeat fresh), UNRESPONSIVE (registered as
  // active but its heartbeat key expired: crashed or partitioned), STOPPED.
  router.get("/workers", authenticate, requirePermission(PERMISSIONS.USER_MANAGE), async (req, res) => {
    res.status(200).json({ workers: await listWorkers() });
  });

  return router;
}
