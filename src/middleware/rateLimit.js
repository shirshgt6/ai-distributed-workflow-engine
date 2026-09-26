import { AppError } from "../utils/errors.js";

// SLIDING-WINDOW LOG rate limiter on Redis, as ONE Lua script (atomic).
//
//   ZREMRANGEBYSCORE key -inf now-window   drop requests older than the window
//   ZCARD key                              how many are left in the window
//   < limit ? ZADD key now <unique>        record this request, allow
//           : refuse, and tell the caller when the oldest one expires
//
// Why sliding window instead of fixed window (INCR per minute): a fixed window
// lets 2x the limit through around the boundary (limit at 12:00:59 + limit
// at 12:01:00). A sliding window never exceeds `limit` in ANY window-sized
// period. Cost: one ZSET entry per request inside the window, bounded by `limit`.
//
// Why Lua: "count, then add" from the app is check-then-act; 20 parallel
// requests could all see count=4 and all pass a limit of 5. In one script,
// they can't.
const SLIDING_WINDOW = `
  local t = redis.call('TIME')
  local now = t[1] * 1000 + math.floor(t[2] / 1000)
  local window = tonumber(ARGV[1])
  local limit = tonumber(ARGV[2])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
  local count = redis.call('ZCARD', KEYS[1])
  if count < limit then
    redis.call('ZADD', KEYS[1], now, now .. '-' .. ARGV[3])
    redis.call('PEXPIRE', KEYS[1], window)
    return {1, limit - count - 1, 0}
  end
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, 0, tonumber(oldest[2]) + window - now}`;

let seq = 0;

/**
 * @param {{
 *   redis: import('ioredis').Redis,
 *   name: string,                         // e.g. "login"
 *   limit: number, windowMs: number,
 *   key: (req) => string | null,          // who is being limited (null = skip)
 *   failClosed?: boolean,                 // Redis down: refuse (true) or allow (false)
 *   logger?: import('pino').Logger,
 *   prefix?: string,
 * }} options
 */
export function rateLimit({ redis, name, limit, windowMs, key, failClosed = false, logger, prefix = "wf:rl" }) {
  return async function rateLimitMiddleware(req, res, next) {
    const who = key(req);
    if (!who) return next();
    let allowed;
    let remaining;
    let retryAfterMs;
    try {
      [allowed, remaining, retryAfterMs] = await redis.eval(SLIDING_WINDOW, 1, `${prefix}:${name}:${who}`, windowMs, limit, `${process.pid}-${++seq}`);
    } catch (err) {
      // AVAILABILITY vs PROTECTION when the limiter itself is down:
      //   fail-open  (general API): don't take the whole API down with Redis
      //   fail-closed (login/register): brute-force protection must not vanish
      (req.log ?? logger)?.warn({ limiter: name, err: err.message, failClosed }, "rate limiter unavailable");
      if (failClosed) return next(new AppError("Temporarily unavailable, try again shortly", { statusCode: 503, code: "RATE_LIMITER_UNAVAILABLE" }));
      return next();
    }
    // IETF draft RateLimit headers: clients can back off before being refused.
    res.set("RateLimit-Limit", String(limit));
    res.set("RateLimit-Remaining", String(remaining));
    if (!allowed) {
      const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.set("Retry-After", String(seconds));
      return next(new AppError(`Too many requests, retry in ${seconds}s`, { statusCode: 429, code: "RATE_LIMITED", details: { retryAfterSeconds: seconds } }));
    }
    next();
  };
}

/**
 * The project's limits. Keys:
 *   login: per (IP + email) AND per IP. The first stops guessing one account's
 *     password; the second stops trying one password against many accounts
 *     (credential stuffing / spraying).
 *   everything authenticated: per user id (IPs are shared behind NATs).
 */
export function createRateLimiters({ redis, logger, scale = 1, prefix = "wf:rl" }) {
  const ip = (req) => req.ip ?? "unknown";
  const email = (req) => String(req.body?.email ?? "").trim().toLowerCase().slice(0, 254);
  const user = (req) => req.user?.id ?? null;
  const n = (x) => Math.max(1, Math.round(x * scale));
  return {
    loginPerAccount: rateLimit({ redis, logger, prefix, name: "login-acct", limit: n(5), windowMs: 15 * 60_000, key: (r) => `${ip(r)}:${email(r)}`, failClosed: true }),
    loginPerIp: rateLimit({ redis, logger, prefix, name: "login-ip", limit: n(20), windowMs: 15 * 60_000, key: ip, failClosed: true }),
    register: rateLimit({ redis, logger, prefix, name: "register", limit: n(5), windowMs: 60 * 60_000, key: ip, failClosed: true }),
    api: rateLimit({ redis, logger, prefix, name: "api", limit: n(300), windowMs: 60_000, key: user }),
    run: rateLimit({ redis, logger, prefix, name: "run", limit: n(60), windowMs: 60_000, key: user }),
    upload: rateLimit({ redis, logger, prefix, name: "upload", limit: n(20), windowMs: 60 * 60_000, key: user }),
  };
}
