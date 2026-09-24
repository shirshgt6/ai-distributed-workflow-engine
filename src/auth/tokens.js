import jwt from "jsonwebtoken";
import { UnauthorizedError } from "../utils/errors.js";

const ISSUER = "workflow-engine";
// Pin the algorithm on VERIFY. Otherwise the token's own header decides how
// it is checked — historically that enabled "alg: none" (no signature at
// all) and algorithm-confusion attacks. The token must never choose.
const ALGORITHM = "HS256";

/**
 * Token service. Access and refresh tokens differ in:
 *   secret  — separate keys, so one kind can never verify as the other
 *   type    — explicit claim, checked on verify (defence in depth)
 *   ttl     — access short (15m), refresh long (7d)
 *   payload — access carries the role (authorization without a DB hit);
 *             refresh carries tokenVersion (revocation check against the DB)
 *
 * @param {{ accessSecret: string, refreshSecret: string, accessTtl: string, refreshTtl: string }} config
 */
export function createTokenService({ accessSecret, refreshSecret, accessTtl, refreshTtl }) {
  function sign(payload, secret, expiresIn) {
    return jwt.sign(payload, secret, { algorithm: ALGORITHM, issuer: ISSUER, expiresIn });
  }

  function verify(token, secret, expectedType) {
    let claims;
    try {
      claims = jwt.verify(token, secret, { algorithms: [ALGORITHM], issuer: ISSUER });
    } catch (err) {
      // Distinguish "expired" so clients know to call /auth/refresh,
      // everything else (bad signature, malformed...) is just "invalid".
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError("Token has expired", { code: "TOKEN_EXPIRED" });
      }
      throw new UnauthorizedError("Invalid token", { code: "INVALID_TOKEN" });
    }
    if (claims.type !== expectedType) {
      throw new UnauthorizedError("Invalid token", { code: "INVALID_TOKEN" });
    }
    return claims;
  }

  return {
    /** Payload is readable by anyone (base64) — ids and role only, never secrets. */
    signAccessToken(user) {
      return sign({ sub: String(user._id), role: user.role, type: "access" }, accessSecret, accessTtl);
    },

    signRefreshToken(user) {
      return sign({ sub: String(user._id), tv: user.tokenVersion, type: "refresh" }, refreshSecret, refreshTtl);
    },

    /** @returns {{ sub: string, role: string }} */
    verifyAccessToken(token) {
      return verify(token, accessSecret, "access");
    },

    /** @returns {{ sub: string, tv: number }} */
    verifyRefreshToken(token) {
      return verify(token, refreshSecret, "refresh");
    },

    accessTtl,
  };
}
