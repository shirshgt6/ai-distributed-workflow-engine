import { z } from "zod";

// Every environment variable the process reads is declared HERE, once, with
// its type and default. Nothing else in the codebase touches process.env.
//
// Why validate at boot? A typo like REDIS_URL=redis//localhost would
// otherwise surface as a confusing connection error minutes later (or only
// on the first request that needs Redis). Failing fast at startup turns a
// runtime mystery into a one-line, obvious error.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Env vars are always strings; z.coerce converts "4000" -> 4000 and still
  // rejects "abc".
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  MONGO_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "must start with mongodb:// or mongodb+srv://"),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must start with redis:// or rediss://"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  BODY_LIMIT: z.string().regex(/^\d+(b|kb|mb)$/, "must look like 100kb / 1mb").default("100kb"),
});

/**
 * Parse and validate configuration.
 *
 * Takes the source as a parameter (instead of reading process.env directly)
 * so tests can pass a plain object — no global mutation needed.
 *
 * @param {Record<string, string | undefined>} [source=process.env]
 * @returns {Readonly<object>} frozen config object
 * @throws {Error} listing EVERY invalid variable at once (not just the first)
 */
export function loadConfig(source = process.env) {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    // Report variable NAMES and the rule broken — never the values, because
    // later phases put secrets in env vars and this message gets logged.
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }

  const env = result.data;

  // Object.freeze: config is read-only after boot. Any code that tries to
  // mutate it at runtime is a bug, and freezing makes that bug visible.
  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    mongo: Object.freeze({ uri: env.MONGO_URI }),
    redis: Object.freeze({ url: env.REDIS_URL }),
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    bodyLimit: env.BODY_LIMIT,
  });
}
