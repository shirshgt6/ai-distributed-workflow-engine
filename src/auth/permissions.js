// RBAC: the ONE place that decides which role may do what.
//
// Code never asks "is this user an admin?". It asks "does this user have
// permission X?". Adding a role, or changing what a role can do, is then an
// edit to this file only — not a hunt through 50 `if (role === ...)` checks.

export const ROLES = Object.freeze({
  ADMIN: "admin",
  OPERATOR: "operator",
  VIEWER: "viewer",
});

export const PERMISSIONS = Object.freeze({
  WORKFLOW_CREATE: "workflow:create",
  WORKFLOW_READ: "workflow:read",
  WORKFLOW_RUN: "workflow:run", // run / pause / resume / cancel
  APPROVAL_DECIDE: "approval:decide",
  ANALYTICS_READ: "analytics:read",
  USER_MANAGE: "user:manage",
});

const P = PERMISSIONS;

// Least privilege: each role gets only what its job needs.
// - viewer is strictly read-only (running a workflow is NOT "viewing").
// - operator does day-to-day work but can NOT manage users — otherwise an
//   operator could promote themselves to admin (privilege escalation).
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: new Set(Object.values(P)),
  [ROLES.OPERATOR]: new Set([P.WORKFLOW_CREATE, P.WORKFLOW_READ, P.WORKFLOW_RUN, P.APPROVAL_DECIDE, P.ANALYTICS_READ]),
  [ROLES.VIEWER]: new Set([P.WORKFLOW_READ, P.ANALYTICS_READ]),
});

/**
 * Deny by default: an unknown role or unknown permission is simply "no".
 * @param {string} role
 * @param {string} permission
 */
export function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}
