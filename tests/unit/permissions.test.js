import { hasPermission, PERMISSIONS as P, ROLES } from "../../src/auth/permissions.js";

// The full matrix, written out explicitly. If someone edits the role table,
// this test forces them to consciously update the expected security policy.
const matrix = {
  [P.WORKFLOW_CREATE]: { admin: true, operator: true, viewer: false },
  [P.WORKFLOW_READ]: { admin: true, operator: true, viewer: true },
  [P.WORKFLOW_RUN]: { admin: true, operator: true, viewer: false },
  [P.APPROVAL_DECIDE]: { admin: true, operator: true, viewer: false },
  [P.ANALYTICS_READ]: { admin: true, operator: true, viewer: true },
  [P.USER_MANAGE]: { admin: true, operator: false, viewer: false },
};

describe("RBAC permission matrix", () => {
  for (const [permission, byRole] of Object.entries(matrix)) {
    for (const [role, expected] of Object.entries(byRole)) {
      test(`${role} ${expected ? "CAN" : "cannot"} ${permission}`, () => {
        expect(hasPermission(role, permission)).toBe(expected);
      });
    }
  }

  test("matrix covers every permission (no untested permission can be added)", () => {
    expect(Object.keys(matrix).sort()).toEqual(Object.values(P).sort());
  });

  test("deny by default: unknown role or permission", () => {
    expect(hasPermission("superuser", P.WORKFLOW_READ)).toBe(false);
    expect(hasPermission(undefined, P.WORKFLOW_READ)).toBe(false);
    expect(hasPermission(ROLES.ADMIN, "workflow:delete-everything")).toBe(false);
  });
});
