import bcrypt from "bcryptjs";

/**
 * bcrypt only uses the first 72 BYTES of a password and silently ignores
 * the rest. Two different long passwords sharing their first 72 bytes would
 * both be accepted. We reject such passwords at validation time instead
 * (see auth.schemas.js). Bytes, not characters: "é" is 2 bytes in UTF-8.
 */
export const BCRYPT_MAX_BYTES = 72;

/**
 * @param {string} plain
 * @param {number} cost work factor; each +1 doubles the time
 * @returns {Promise<string>} "$2b$<cost>$<22-char salt><31-char hash>" — the
 *   salt and cost are stored INSIDE the hash string, so no separate salt column.
 */
export function hashPassword(plain, cost) {
  return bcrypt.hash(plain, cost);
}

/**
 * Re-hashes `plain` with the salt+cost read from `hash` and compares.
 * @returns {Promise<boolean>}
 */
export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
