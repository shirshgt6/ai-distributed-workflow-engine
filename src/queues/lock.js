import { randomUUID } from "node:crypto";

// DISTRIBUTED LOCK on a single Redis node.
//
//   acquire: SET lock:<name> <random token> NX PX <ttl>   -> only one holder
//   release: delete ONLY IF the value is still MY token    (Lua: compare-and-delete)
//   extend:  push the expiry ONLY IF I still hold it        (Lua: compare-and-pexpire)
//
// Why a random token per acquisition: if my lock expired (I was paused for
// longer than the TTL) and someone else acquired it, a plain DEL on release
// would delete THEIR lock. Comparing the token first prevents that.
//
// Why a TTL at all: a holder that crashes never releases. The TTL makes the
// lock free itself, so the system can't deadlock on a dead holder.
//
// What a lock does NOT guarantee: a holder paused (GC, network) past the TTL
// still believes it holds the lock while someone else does too. So every
// acquisition also gets a monotonically increasing FENCING TOKEN (INCR), and
// anything the holder writes should carry it so stale holders can be rejected.
// This project uses the lock for scheduler leader election (Phase 12), where a
// rare double tick is made harmless by idempotency keys.
// (Redlock across several Redis nodes is deliberately not used; see docs/redis.md.)

const RELEASE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0`;

const EXTEND = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0`;

/**
 * @param {import('ioredis').Redis} redis
 * @param {string} name
 * @param {{ ttlMs: number, prefix?: string }} options
 */
export function createLock(redis, name, { ttlMs, prefix = "wf:lock" }) {
  const key = `${prefix}:${name}`;
  const fenceKey = `${key}:fence`;

  return {
    key,

    /** @returns {Promise<{ token: string, fence: number } | null>} null = someone else holds it */
    async acquire() {
      const token = randomUUID();
      const ok = await redis.set(key, token, "PX", ttlMs, "NX");
      if (ok !== "OK") return null;
      const fence = await redis.incr(fenceKey);
      return { token, fence };
    },

    /** @returns {Promise<boolean>} false = we no longer held it (expired / taken over) */
    async release(token) {
      return (await redis.eval(RELEASE, 1, key, token)) === 1;
    },

    /** @returns {Promise<boolean>} false = we lost it; stop acting as the holder */
    async extend(token, newTtlMs = ttlMs) {
      return (await redis.eval(EXTEND, 1, key, token, newTtlMs)) === 1;
    },
  };
}
