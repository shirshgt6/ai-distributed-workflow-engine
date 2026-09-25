import { CronExpressionParser } from "cron-parser";
import { ValidationError } from "../utils/errors.js";

/**
 * Standard 5-field cron only ("m h dom mon dow"), minute granularity.
 * 6-field (seconds) expressions are rejected: a per-second schedule would
 * start 86,400 runs a day from one misconfigured definition.
 */
export function assertValidCron(expr, timezone = "UTC") {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ValidationError("cron must have exactly 5 fields: minute hour day-of-month month day-of-week", {
      code: "INVALID_CRON",
    });
  }
  // cron-parser doesn't reject unknown timezones at parse time; Intl does.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ValidationError(`Invalid cron expression or timezone: unknown timezone "${timezone}"`, { code: "INVALID_CRON" });
  }
  try {
    CronExpressionParser.parse(expr, { tz: timezone }).next();
  } catch (err) {
    throw new ValidationError(`Invalid cron expression or timezone: ${err.message}`, { code: "INVALID_CRON" });
  }
}

/** The first slot strictly after `after`, in the given IANA timezone. */
export function nextRunAfter(expr, after, timezone = "UTC") {
  return CronExpressionParser.parse(expr, { currentDate: after, tz: timezone }).next().toDate();
}
