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

/** 400 — request is malformed / fails validation. */
export class ValidationError extends AppError {
  constructor(message = "Request validation failed", options = {}) {
    super(message, { statusCode: 400, code: "VALIDATION_ERROR", ...options });
  }
}

/** 401 — we don't know who you are (missing/invalid/expired credentials). */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required", options = {}) {
    super(message, { statusCode: 401, code: "UNAUTHENTICATED", ...options });
  }
}

/** 403 — we know who you are, and you're not allowed to do this. */
export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action", options = {}) {
    super(message, { statusCode: 403, code: "FORBIDDEN", ...options });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", options = {}) {
    super(message, { statusCode: 404, code: "NOT_FOUND", ...options });
  }
}

/** 409 — request conflicts with current state (duplicate, wrong state...). */
export class ConflictError extends AppError {
  constructor(message = "Conflict", options = {}) {
    super(message, { statusCode: 409, code: "CONFLICT", ...options });
  }
}
