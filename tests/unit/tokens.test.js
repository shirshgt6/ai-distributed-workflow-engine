import jwt from "jsonwebtoken";
import { createTokenService } from "../../src/auth/tokens.js";

const config = {
  accessSecret: "access-secret-for-tests-0123456789abcdef",
  refreshSecret: "refresh-secret-for-tests-0123456789abcdef",
  accessTtl: "15m",
  refreshTtl: "7d",
};
const tokens = createTokenService(config);
const user = { _id: "652f1c2b9d1e8a0012345678", role: "operator", tokenVersion: 3 };

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  throw new Error("expected function to throw");
}

describe("token service", () => {
  test("access token round-trip carries id + role, nothing sensitive", () => {
    const claims = tokens.verifyAccessToken(tokens.signAccessToken(user));
    expect(claims).toMatchObject({ sub: user._id, role: "operator", type: "access", iss: "workflow-engine" });
    expect(claims.exp - claims.iat).toBe(15 * 60);
  });

  test("refresh token carries the tokenVersion", () => {
    const claims = tokens.verifyRefreshToken(tokens.signRefreshToken(user));
    expect(claims).toMatchObject({ sub: user._id, tv: 3, type: "refresh" });
  });

  test("a refresh token is NOT accepted as an access token (and vice versa)", () => {
    expect(codeOf(() => tokens.verifyAccessToken(tokens.signRefreshToken(user)))).toBe("INVALID_TOKEN");
    expect(codeOf(() => tokens.verifyRefreshToken(tokens.signAccessToken(user)))).toBe("INVALID_TOKEN");
  });

  test("even with the right 'type', a token signed with another secret is rejected", () => {
    const forged = jwt.sign({ sub: user._id, role: "admin", type: "access" }, "attacker-guess", {
      issuer: "workflow-engine",
    });
    expect(codeOf(() => tokens.verifyAccessToken(forged))).toBe("INVALID_TOKEN");
  });

  test("tampering with the payload breaks the signature", () => {
    const [header, , signature] = tokens.signAccessToken(user).split(".");
    const evilPayload = Buffer.from(JSON.stringify({ sub: user._id, role: "admin", type: "access" })).toString(
      "base64url"
    );
    expect(codeOf(() => tokens.verifyAccessToken(`${header}.${evilPayload}.${signature}`))).toBe("INVALID_TOKEN");
  });

  test('"alg: none" (unsigned) tokens are rejected', () => {
    const unsigned = jwt.sign({ sub: user._id, role: "admin", type: "access", iss: "workflow-engine" }, null, {
      algorithm: "none",
    });
    expect(codeOf(() => tokens.verifyAccessToken(unsigned))).toBe("INVALID_TOKEN");
  });

  test("expired token gets a distinct TOKEN_EXPIRED code", () => {
    const expired = jwt.sign({ sub: user._id, role: "operator", type: "access" }, config.accessSecret, {
      issuer: "workflow-engine",
      expiresIn: -10,
    });
    expect(codeOf(() => tokens.verifyAccessToken(expired))).toBe("TOKEN_EXPIRED");
  });

  test("garbage is rejected", () => {
    expect(codeOf(() => tokens.verifyAccessToken("not.a.jwt"))).toBe("INVALID_TOKEN");
  });
});
