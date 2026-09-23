import pino from "pino";

// Paths whose values must never reach a log line. Logs are usually shipped
// to third-party tools and read by many people, so treat them as semi-public.
// More paths get added as features introduce new sensitive fields.
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
];

/**
 * Create the root structured (JSON) logger.
 *
 * Structured = every log line is a JSON object with fields
 * (level, time, reqId, workflowId...) rather than free text, so a log
 * system can filter "all lines where workflowId = X" across many processes.
 *
 * @param {{ level?: string, pretty?: boolean }} [options]
 *   pretty: human-readable colored output for local dev. Production keeps
 *   raw JSON because machines, not humans, read it first.
 */
export function createLogger({ level = "info", pretty = false } = {}) {
  return pino({
    level,
    base: { service: "workflow-engine" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    transport: pretty
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,service" },
        }
      : undefined,
  });
}
