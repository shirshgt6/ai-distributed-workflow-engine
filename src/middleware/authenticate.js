import { UnauthorizedError } from "../utils/errors.js";

/**
 * AUTHENTICATION: "who are you?"
 *
 * Reads `Authorization: Bearer <accessToken>`, verifies it WITHOUT touching
 * the database (signature + expiry only — that's the point of a stateless
 * token), and sets req.user = { id, role }.
 *
 * Consequence to remember: a role change or logout does not affect an
 * access token already issued; it stays valid until it expires (15m).
 *
 * @param {ReturnType<import('../auth/tokens.js').createTokenService>} tokens
 */
export function createAuthenticate(tokens) {
  return function authenticate(req, res, next) {
    const header = req.get("authorization") ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      // RFC 6750: a 401 should tell the client which auth scheme to use.
      res.set("WWW-Authenticate", "Bearer");
      return next(new UnauthorizedError("Missing or malformed Authorization header"));
    }

    try {
      const claims = tokens.verifyAccessToken(token);
      req.user = { id: claims.sub, role: claims.role };
      next();
    } catch (err) {
      res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
      next(err);
    }
  };
}
