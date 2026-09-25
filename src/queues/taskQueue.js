// RELIABLE TASK QUEUE on Redis.
//
// MongoDB stays the source of truth for task STATE. Redis only answers
// "which task id should a worker pick up next?" — fast, atomic, and shared by
// every process. Anything in here can be rebuilt from MongoDB (see the engine's
// reconciler), which is why losing Redis data is an inconvenience, not a
// correctness disaster.
//
// Keys (prefix configurable so tests can isolate themselves):
//   <p>:ready    LIST  task ids waiting for a worker (FIFO: RPUSH in, LPOP out)
//   <p>:leases   ZSET  task ids a worker has claimed; score = lease deadline (ms)
//   <p>:delayed  ZSET  task ids that must wait; score = when they become ready (ms)
//   <p>:members  SET   every id currently in ready ∪ leases ∪ delayed (dedupe)
//
// Every operation that touches more than one key is a Lua script. Redis runs a
// script as ONE command: nothing else executes in between, so there is no
// window where a task id is in neither structure — the "pop, then crash before
// recording it" bug that silently lost jobs in Project 1 cannot happen.
//
// Time comes from Redis itself (TIME), never from the caller's clock, so
// workers on machines with skewed clocks still agree on when a lease expires.

// Current Redis server time in milliseconds.
const NOW_MS = "local t = redis.call('TIME'); local now = t[1] * 1000 + math.floor(t[2] / 1000)";

const SCRIPTS = {
  // ENQUEUE: add to the ready list unless the id is already somewhere in the
  // queue. Makes enqueue idempotent: the reconciler may re-enqueue a task that
  // is still queued, and it must not become two list entries.
  wfEnqueue: {
    numberOfKeys: 2, // members, ready
    lua: `
      if redis.call('SADD', KEYS[1], ARGV[1]) == 1 then
        redis.call('RPUSH', KEYS[2], ARGV[1])
        return 1
      end
      return 0`,
  },

  // ENQUEUE LATER: same dedupe, but into the delayed set (retries, Phase 8).
  wfEnqueueDelayed: {
    numberOfKeys: 2, // members, delayed
    lua: `
      ${NOW_MS}
      if redis.call('SADD', KEYS[1], ARGV[1]) == 1 then
        redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[1])
        return 1
      end
      return 0`,
  },

  // CLAIM: pop the next id AND record a lease for it, atomically.
  // The id stays in `members` (it is still "in the queue", just leased).
  wfClaim: {
    numberOfKeys: 2, // ready, leases
    lua: `
      ${NOW_MS}
      local id = redis.call('LPOP', KEYS[1])
      if not id then return false end
      redis.call('ZADD', KEYS[2], now + tonumber(ARGV[1]), id)
      return id`,
  },

  // EXTEND: push a lease deadline further out — only if we still hold it.
  wfExtendLease: {
    numberOfKeys: 1, // leases
    lua: `
      ${NOW_MS}
      if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
        redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
        return 1
      end
      return 0`,
  },

  // ACK: the task's outcome is safely in MongoDB; forget it here.
  wfAck: {
    numberOfKeys: 2, // leases, members
    lua: `
      redis.call('ZREM', KEYS[1], ARGV[1])
      return redis.call('SREM', KEYS[2], ARGV[1])`,
  },

  // REAPER: leases whose deadline passed -> back to the ready list.
  // ZREM's return value guarantees each id is moved once even if two
  // reapers run concurrently (though inside one script they can't interleave anyway).
  wfRequeueExpired: {
    numberOfKeys: 2, // leases, ready
    lua: `
      ${NOW_MS}
      local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[1]))
      for _, id in ipairs(ids) do
        if redis.call('ZREM', KEYS[1], id) == 1 then
          redis.call('RPUSH', KEYS[2], id)
        end
      end
      return ids`,
  },

  // PROMOTER: delayed tasks whose time has come -> ready list.
  // Project 1 did ZRANGEBYSCORE then ZREM as separate round-trips from the
  // app; here it is one atomic step.
  wfPromoteDue: {
    numberOfKeys: 2, // delayed, ready
    lua: `
      ${NOW_MS}
      local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[1]))
      for _, id in ipairs(ids) do
        if redis.call('ZREM', KEYS[1], id) == 1 then
          redis.call('RPUSH', KEYS[2], id)
        end
      end
      return ids`,
  },
};

/**
 * @param {import('ioredis').Redis} redis
 * @param {{ prefix?: string }} [options]
 */
export function createTaskQueue(redis, { prefix = "wf:q" } = {}) {
  // defineCommand sends the script once (EVALSHA afterwards) and exposes it
  // as a method, e.g. redis.wfClaim(...). Idempotent across instances.
  for (const [name, { numberOfKeys, lua }] of Object.entries(SCRIPTS)) {
    if (typeof redis[name] !== "function") {
      redis.defineCommand(name, { numberOfKeys, lua });
    }
  }

  const keys = {
    ready: `${prefix}:ready`,
    leases: `${prefix}:leases`,
    delayed: `${prefix}:delayed`,
    members: `${prefix}:members`,
  };

  return {
    keys,

    /** @returns {Promise<boolean>} true if added, false if already queued */
    async enqueue(taskId) {
      return (await redis.wfEnqueue(keys.members, keys.ready, String(taskId))) === 1;
    },

    /** Make the task ready after `delayMs` (used for retry backoff). */
    async enqueueDelayed(taskId, delayMs) {
      return (await redis.wfEnqueueDelayed(keys.members, keys.delayed, String(taskId), Math.max(0, Math.round(delayMs)))) === 1;
    },

    /**
     * Take the next task and lease it for `leaseMs`.
     * @returns {Promise<string|null>} task id, or null if the queue is empty
     */
    async claim(leaseMs) {
      return redis.wfClaim(keys.ready, keys.leases, Math.round(leaseMs));
    },

    /** @returns {Promise<boolean>} false if the lease is gone (reaped) */
    async extendLease(taskId, leaseMs) {
      return (await redis.wfExtendLease(keys.leases, String(taskId), Math.round(leaseMs))) === 1;
    },

    /** Done with this task (its result is already stored in MongoDB). */
    async ack(taskId) {
      return (await redis.wfAck(keys.leases, keys.members, String(taskId))) === 1;
    },

    /** @returns {Promise<string[]>} ids whose lease expired and were requeued */
    async requeueExpired(limit = 100) {
      return redis.wfRequeueExpired(keys.leases, keys.ready, limit);
    },

    /** @returns {Promise<string[]>} delayed ids that became ready */
    async promoteDue(limit = 100) {
      return redis.wfPromoteDue(keys.delayed, keys.ready, limit);
    },

    async stats() {
      const [ready, leased, delayed] = await Promise.all([
        redis.llen(keys.ready),
        redis.zcard(keys.leases),
        redis.zcard(keys.delayed),
      ]);
      return { ready, leased, delayed };
    },
  };
}
