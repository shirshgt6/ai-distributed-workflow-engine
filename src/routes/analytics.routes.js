import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requirePermission } from "../middleware/authorize.js";
import { PERMISSIONS } from "../auth/permissions.js";

const windowSchema = { query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }) };
const fromDays = (days) => new Date(Date.now() - days * 24 * 3600 * 1000);

export function createAnalyticsRouter({ authenticate, analyticsService }) {
  const router = Router();
  router.use("/analytics", authenticate, requirePermission(PERMISSIONS.ANALYTICS_READ));

  router.get("/analytics/ai", validate(windowSchema), async (req, res) => {
    res.status(200).json(await analyticsService.ai(req.user, { from: fromDays(req.valid.query.days) }));
  });
  router.get("/analytics/workflows", validate(windowSchema), async (req, res) => {
    res.status(200).json(await analyticsService.workflows(req.user, { from: fromDays(req.valid.query.days) }));
  });
  return router;
}
