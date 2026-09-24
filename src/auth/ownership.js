import { ROLES } from "./permissions.js";

/**
 * OBJECT-LEVEL AUTHORIZATION — the check RBAC cannot do.
 *
 * RBAC answered "may an operator read workflows?". This answers "which
 * workflows?". Returns a Mongo filter fragment that is merged into EVERY
 * query for an owned resource:
 *
 *   Workflow.findOne({ _id: id, ...ownerScope(req.user) })
 *
 * Because the ownership condition is part of the query itself, a foreign
 * document is simply "not found" -> 404. We never load it and then decide,
 * so there is no code path that could forget the check after loading.
 *
 * Admins see everything (empty filter).
 *
 * @param {{ id: string, role: string }} user
 */
export function ownerScope(user) {
  return user.role === ROLES.ADMIN ? {} : { ownerId: user.id };
}
