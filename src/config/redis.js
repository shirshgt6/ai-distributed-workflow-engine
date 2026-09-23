import Redis from "ioredis";

/**
 * Create (but do not yet connect) an ioredis client.
 *
 * lazyConnect: construction has no side effects; server.js decides when to
 *   connect and can await it (so boot fails fast if Redis is down).
 * enableOfflineQueue=false: while disconnected, commands FAIL IMMEDIATELY
 *   instead of piling up in memory waiting for a reconnect. For an API that
 *   is what we want — return 503 now rather than hang the request.
 * retryStrategy: reconnect with growing delays (200ms, 400ms ... capped at
 *   5s) — the same backoff idea we'll use for task retries in Phase 8.
 *
 * @param {string} url
 * @param {import('pino').Logger} logger
 * @param {{ name?: string }} [options] name shows up in Redis CLIENT LIST
 */
export function createRedisClient(url, logger, { name = "api" } = {}) {
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectionName: `workflow-engine:${name}`,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  client.on("ready", () => logger.info({ redis: name }, "redis ready"));
  client.on("end", () => logger.warn({ redis: name }, "redis connection ended"));
  // Connection failures arrive as an AggregateError whose .message is EMPTY;
  // the useful part is .code (e.g. ECONNREFUSED). Log both.
  client.on("error", (err) =>
    logger.error({ redis: name, code: err.code, err: err.message || String(err) }, "redis error")
  );

  return client;
}

/** Readiness probe. */
export async function pingRedis(client) {
  const reply = await client.ping();
  if (reply !== "PONG") {
    throw new Error(`unexpected PING reply: ${reply}`);
  }
}
