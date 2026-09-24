import { Router } from "express";
import { createAuthController } from "../controllers/auth.controller.js";
import { validate } from "../middleware/validate.js";
import { requirePermission } from "../middleware/authorize.js";
import { PERMISSIONS } from "../auth/permissions.js";
import { changeRoleSchema, loginSchema, refreshSchema, registerSchema } from "../auth/auth.schemas.js";

/**
 * Reading a route line left to right = the order checks happen:
 *   authenticate (401) -> requirePermission (403) -> validate (400) -> controller
 * Auth runs BEFORE validation so an anonymous caller learns nothing about
 * the expected request shape of protected endpoints.
 */
export function createAuthRouter({ authService, authenticate }) {
  const c = createAuthController(authService);
  const router = Router();

  router.post("/auth/register", validate(registerSchema), c.register);
  router.post("/auth/login", validate(loginSchema), c.login);
  router.post("/auth/refresh", validate(refreshSchema), c.refresh);
  router.post("/auth/logout", authenticate, c.logout);
  router.get("/auth/me", authenticate, c.me);

  router.patch(
    "/users/:id/role",
    authenticate,
    requirePermission(PERMISSIONS.USER_MANAGE),
    validate(changeRoleSchema),
    c.changeRole
  );

  return router;
}
