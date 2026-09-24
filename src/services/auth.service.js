import { hashPassword, verifyPassword } from "../auth/password.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../utils/errors.js";

const DUPLICATE_KEY = 11000; // MongoDB error code for unique index violation

/**
 * @param {{
 *   User: import('mongoose').Model,
 *   tokens: ReturnType<import('../auth/tokens.js').createTokenService>,
 *   bcryptCost: number
 * }} deps
 */
export function createAuthService({ User, tokens, bcryptCost }) {
  // TIMING-ATTACK DEFENCE for login.
  // If the email doesn't exist we'd normally return instantly (~2ms), while a
  // wrong password costs a bcrypt compare (~250ms). Same error message, but
  // the response TIME would still reveal which emails are registered.
  // So for unknown emails we compare against this dummy hash — same cost,
  // same duration.
  // Computed EAGERLY at startup, not on first use: a lazy version made the
  // FIRST unknown-email login pay for hashing + comparing (~2x slower),
  // which is itself a measurable timing leak (caught in the Phase 2 smoke test).
  const dummyHashPromise = hashPassword("timing-equaliser-not-a-real-password", bcryptCost);
  const dummyHash = () => dummyHashPromise;

  function issueTokens(user) {
    return {
      tokenType: "Bearer",
      accessToken: tokens.signAccessToken(user),
      expiresIn: tokens.accessTtl,
      refreshToken: tokens.signRefreshToken(user),
    };
  }

  return {
    /** Always creates a VIEWER. The role is never taken from the request. */
    async register({ email, password }) {
      const passwordHash = await hashPassword(password, bcryptCost);
      try {
        const user = await User.create({ email, passwordHash });
        return user;
      } catch (err) {
        // No "findOne first" pre-check: two simultaneous registrations would
        // both pass it. The unique index decides; we just translate its error.
        if (err?.code === DUPLICATE_KEY) {
          throw new ConflictError("An account with this email already exists", { code: "EMAIL_TAKEN" });
        }
        throw err;
      }
    },

    async login({ email, password }) {
      const user = await User.findOne({ email }).select("+passwordHash");

      // Always run exactly one bcrypt compare, whether or not the user exists.
      const ok = await verifyPassword(password, user ? user.passwordHash : await dummyHash());
      if (!user || !ok) {
        // One message for both cases -> no user enumeration.
        throw new UnauthorizedError("Invalid email or password", { code: "INVALID_CREDENTIALS" });
      }

      return { user, ...issueTokens(user) };
    },

    /**
     * Exchange a valid refresh token for a new token pair.
     * Revocation check: token.tv must equal the user's CURRENT tokenVersion.
     */
    async refresh(refreshToken) {
      const claims = tokens.verifyRefreshToken(refreshToken);
      const user = await User.findById(claims.sub);

      if (!user || user.tokenVersion !== claims.tv) {
        throw new UnauthorizedError("Refresh token has been revoked", { code: "TOKEN_REVOKED" });
      }
      return issueTokens(user);
    },

    /**
     * Revokes ALL refresh tokens of the user (every device), atomically.
     * Access tokens already issued stay valid until they expire (<= access TTL):
     * that is the price of stateless access tokens.
     */
    async logoutAll(userId) {
      await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
    },

    async getUser(userId) {
      const user = await User.findById(userId);
      if (!user) throw new NotFoundError("User not found");
      return user;
    },

    /**
     * Admin changes another user's role. Also bumps tokenVersion so the user
     * can't keep refreshing tokens that carry the OLD role.
     */
    async changeRole({ actorId, targetId, role }) {
      // Prevents an admin from accidentally demoting themselves and leaving
      // the system with no admin at all.
      if (String(actorId) === String(targetId)) {
        throw new ForbiddenError("You cannot change your own role", { code: "SELF_ROLE_CHANGE" });
      }
      const user = await User.findByIdAndUpdate(
        targetId,
        { $set: { role }, $inc: { tokenVersion: 1 } },
        { returnDocument: "after", runValidators: true }
      );
      if (!user) throw new NotFoundError("User not found");
      return user;
    },
  };
}
