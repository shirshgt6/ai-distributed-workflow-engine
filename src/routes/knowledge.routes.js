import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { validate } from "../middleware/validate.js";
import { requirePermission } from "../middleware/authorize.js";
import { PERMISSIONS } from "../auth/permissions.js";
import { ownerScope } from "../auth/ownership.js";
import { NotFoundError } from "../utils/errors.js";

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), { message: "must be a valid id" });

const uploadSchema = {
  body: z.object({
    title: z.string().trim().min(1).max(200),
    // Plain text / markdown only. PDF & DOCX extraction are not implemented.
    mimeType: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
    content: z.string().min(20).max(200_000),
  }),
};
const searchSchema = {
  body: z.object({ query: z.string().trim().min(1).max(1000), topK: z.number().int().min(1).max(20).default(4) }),
};

/**
 * Knowledge base for RAG. Every document belongs to its uploader, and every
 * search is filtered by owner, both in MongoDB and inside the Qdrant query.
 */
export function createKnowledgeRouter({ authenticate, rag, KnowledgeDocument }) {
  const router = Router();
  router.use(["/documents", "/knowledge"], authenticate);

  router.post("/documents", requirePermission(PERMISSIONS.WORKFLOW_CREATE), validate(uploadSchema), async (req, res) => {
    const document = await rag.ingest({ ownerId: req.user.id, ...req.valid.body });
    res.status(201).location(`/documents/${document._id}`).json({ document });
  });

  router.get("/documents", requirePermission(PERMISSIONS.WORKFLOW_READ), async (req, res) => {
    const documents = await KnowledgeDocument.find(ownerScope(req.user)).sort({ createdAt: -1 }).limit(100);
    res.status(200).json({ documents });
  });

  router.get("/documents/:id", requirePermission(PERMISSIONS.WORKFLOW_READ), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
    const document = await KnowledgeDocument.findOne({ _id: req.valid.params.id, ...ownerScope(req.user) });
    if (!document) throw new NotFoundError("Document not found");
    res.status(200).json({ document });
  });

  router.delete("/documents/:id", requirePermission(PERMISSIONS.WORKFLOW_CREATE), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
    await rag.deleteDocument({ ownerScopeFilter: ownerScope(req.user), documentId: req.valid.params.id });
    res.status(204).end();
  });

  // Retrieval only (no LLM): see exactly which chunks a question would use.
  router.post("/knowledge/search", requirePermission(PERMISSIONS.WORKFLOW_READ), validate(searchSchema), async (req, res) => {
    const results = await rag.retrieve({ ownerId: req.user.id, query: req.valid.body.query, k: req.valid.body.topK });
    res.status(200).json({ results });
  });

  return router;
}
