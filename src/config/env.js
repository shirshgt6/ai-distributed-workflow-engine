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

  // HS256 signs with a shared secret; a short secret can be brute-forced
  // offline from any one token an attacker sees. 32+ chars ~ 256 bits when random.
  JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Format understood by jsonwebtoken: "15m", "7d", "3600" (seconds)...
  JWT_ACCESS_TTL: z.string().regex(/^\d+[smhd]?$/, "must look like 15m / 7d").default("15m"),
  JWT_REFRESH_TTL: z.string().regex(/^\d+[smhd]?$/, "must look like 15m / 7d").default("7d"),
  // bcrypt work factor: each +1 DOUBLES hashing time. 12 is a common
  // production baseline; tests lower it (min 4) purely for speed.
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
}).refine((env) => env.JWT_ACCESS_SECRET !== env.JWT_REFRESH_SECRET, {
  // Same secret for both would let a refresh token pass access-token
  // verification (or vice versa) if the `type` claim check were ever missed.
  message: "must differ from JWT_ACCESS_SECRET",
  path: ["JWT_REFRESH_SECRET"],
}).refine(
  // .env.example ships "change-me-..." placeholders so a fresh clone boots
  // locally. Deploying them to production would mean anyone who has read
  // the public repo can forge tokens — so production refuses to start.
  (env) => env.NODE_ENV !== "production" || ![env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET].some((s) => s.startsWith("change-me")),
  { message: "placeholder JWT secrets are not allowed in production", path: ["JWT_ACCESS_SECRET"] }
);

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
    auth: Object.freeze({
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtl: env.JWT_REFRESH_TTL,
      bcryptCost: env.BCRYPT_COST,
    }),
  });
}
