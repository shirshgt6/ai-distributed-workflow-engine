import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { validate } from "../middleware/validate.js";
import { requirePermission } from "../middleware/authorize.js";
import { PERMISSIONS } from "../auth/permissions.js";
import { ownerScope } from "../auth/ownership.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), { message: "must be a valid id" });
const idParams = { params: z.object({ id: objectId }) };
const decideSchema = { params: z.object({ id: objectId }), body: z.object({ comment: z.string().trim().max(1000).optional() }) };
const listSchema = { query: z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]).optional() }) };

/**
 * Approvals belong to the RUN OWNER (admins see all). Deciding needs the
 * approval:decide permission AND ownership. Someone else's approval is a 404.
 */
export function createApprovalRouter({ authenticate, engine, ApprovalRequest }) {
  const router = Router();
  router.use("/approvals", authenticate);

  router.get("/approvals", requirePermission(PERMISSIONS.WORKFLOW_READ), validate(listSchema), async (req, res) => {
    const filter = { ...ownerScope(req.user), ...(req.valid.query.status && { status: req.valid.query.status }) };
    const approvals = await ApprovalRequest.find(filter).sort({ createdAt: -1 }).limit(100);
    res.status(200).json({ approvals });
  });

  router.get("/approvals/:id", requirePermission(PERMISSIONS.WORKFLOW_READ), validate(idParams), async (req, res) => {
    const approval = await ApprovalRequest.findOne({ _id: req.valid.params.id, ...ownerScope(req.user) });
    if (!approval) throw new NotFoundError("Approval not found");
    res.status(200).json({ approval });
  });

  for (const [action, decision] of [
    ["approve", "APPROVED"],
    ["reject", "REJECTED"],
  ]) {
    router.post(`/approvals/:id/${action}`, requirePermission(PERMISSIONS.APPROVAL_DECIDE), validate(decideSchema), async (req, res) => {
      const scope = ownerScope(req.user);
      const existing = await ApprovalRequest.findOne({ _id: req.valid.params.id, ...scope }).select("status");
      if (!existing) throw new NotFoundError("Approval not found");
      if (existing.status !== "PENDING") {
        throw new ConflictError(`Approval is already ${existing.status}`, { code: "ALREADY_DECIDED", details: { status: existing.status } });
      }
      const { outcome } = await engine.resolveApproval({
        approvalId: existing._id,
        decision,
        decidedBy: req.user.id,
        comment: req.valid.body.comment ?? null,
        scope,
      });
      if (!outcome) {
        // Lost the race: someone else (or the timeout) decided a moment ago.
        const now = await ApprovalRequest.findById(existing._id).select("status");
        throw new ConflictError(`Approval is already ${now.status}`, { code: "ALREADY_DECIDED", details: { status: now.status } });
      }
      res.status(200).json({ approval: await ApprovalRequest.findById(existing._id) });
    });
  }

  return router;
}
