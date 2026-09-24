import { hasPermission } from "../auth/permissions.js";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";

/**
 * AUTHORIZATION (action level): "may this role do this kind of thing?"
 *
 * NOT the whole story: it cannot answer "is THIS workflow yours?". That
 * object-level (ownership) check lives in the service layer, where the
 * object is loaded — see Phase 3. Missing it is the BOLA/IDOR bug.
 *
 * @param {string} permission one of PERMISSIONS
 */
export function requirePermission(permission) {
  return (req, _res, next) => {
    // authenticate must run first; if it didn't, fail closed.
    if (!req.user) {
      return next(new UnauthorizedError());
    }
    if (!hasPermission(req.user.role, permission)) {
      return next(new ForbiddenError(undefined, { details: { required: permission } }));
    }
    next();
  };
}
