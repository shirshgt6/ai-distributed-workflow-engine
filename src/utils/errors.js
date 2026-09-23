/**
 * Base class for errors we EXPECT and know how to describe to a client
 * (bad input, missing resource, dependency down...).
 *
 * Anything thrown that is NOT an AppError is treated as a bug: the client
 * gets a generic 500 and the details only go to the logs. This split is
 * what stops stack traces / internal messages leaking to users.
 */
export class AppError extends Error {
  /**
   * @param {string} message safe to show to the client
   * @param {{ statusCode?: number, code?: string, details?: unknown, cause?: unknown }} [options]
   */
  constructor(message, { statusCode = 500, code = "INTERNAL_ERROR", details, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code; // stable, machine-readable — clients branch on this, not on message text
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", options = {}) {
    super(message, { statusCode: 404, code: "NOT_FOUND", ...options });
  }
}
