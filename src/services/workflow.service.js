import { ownerScope } from "../auth/ownership.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

/**
 * Workflow DEFINITIONS (the "recipes"). Running them is Phase 5.
 *
 * Every read/write merges ownerScope(user) into the Mongo filter, so a
 * non-admin can only ever see or touch their own workflows. Someone else's
 * workflow is indistinguishable from a non-existent one: 404, not 403 — a
 * 403 would confirm "this id exists", which is an information leak.
 *
 * @param {{ Workflow: import('mongoose').Model }} deps
 */
export function createWorkflowService({ Workflow }) {
  const notFound = () => new NotFoundError("Workflow not found");

  return {
    async create(user, { name, description, tasks }) {
      // ownerId comes from the authenticated user, never from the body.
      return Workflow.create({ ownerId: user.id, name, description, tasks });
    },

    async list(user, { limit, page }) {
      const filter = ownerScope(user);
      // Offset pagination: simple and fine for small collections. It gets
      // slower for deep pages (Mongo still walks the skipped docs) and can
      // skip/duplicate items if data changes between pages — cursor
      // pagination (createdAt/_id "after") fixes both. Documented trade-off.
      const [items, total] = await Promise.all([
        Workflow.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        Workflow.countDocuments(filter),
      ]);
      return { items, page, limit, total };
    },

    async get(user, id) {
      const workflow = await Workflow.findOne({ _id: id, ...ownerScope(user) });
      if (!workflow) throw notFound();
      return workflow;
    },

    /**
     * Replace the definition — OPTIMISTIC CONCURRENCY.
     *
     * The client sends the version it last saw. The update is conditional on
     * that version still being current, and bumps it, in ONE atomic
     * operation. No lock is held while the user edits for minutes in a UI;
     * conflicts are detected at save time instead.
     */
    async update(user, id, { version, name, description, tasks }) {
      const updated = await Workflow.findOneAndUpdate(
        { _id: id, ...ownerScope(user), version },
        { $set: { name, description, tasks }, $inc: { version: 1 } },
        { new: true, runValidators: true }
      );
      if (updated) return updated;

      // Nothing matched: either it isn't visible to this user (404) or the
      // version moved on (409). One extra read, only on the failure path, to
      // tell the client which — using the SAME ownership scope, so this can't
      // leak the existence of other users' workflows.
      const current = await Workflow.findOne({ _id: id, ...ownerScope(user) }).select("version");
      if (!current) throw notFound();
      throw new ConflictError(
        `Workflow was modified by someone else (you sent version ${version}, current is ${current.version}). Reload and retry.`,
        { code: "VERSION_CONFLICT", details: { currentVersion: current.version } }
      );
    },
  };
}
