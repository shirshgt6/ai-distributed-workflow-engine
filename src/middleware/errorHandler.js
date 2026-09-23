import { AppError, NotFoundError } from "../utils/errors.js";

/** Catch-all for unmatched routes. Must be registered after every router. */
export function notFound(req, res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}

/**
 * The single place that turns an error into an HTTP response.
 *
 * Express 5 forwards rejected promises from async handlers here
 * automatically (Express 4 needed try/catch or a wrapper in every handler).
 *
 * Every error response has the same shape, so clients parse one format:
 *   { "error": { "code": "...", "message": "...", "requestId": "..." } }
 *
 * The 4 parameters are required: that arity is how Express recognizes an
 * error-handling middleware.
 */
export function errorHandler(err, req, res, next) {
  // Response already partially sent (e.g. error mid-stream): we can't send a
  // new status/body, so let Express close the connection.
  if (res.headersSent) {
    return next(err);
  }

  const { statusCode, code, message, details } = toHttpError(err);

  if (statusCode >= 500) {
    // Full error + stack go to logs only. The client gets a generic message.
    req.log?.error({ err }, "unhandled error");
  }

  res.status(statusCode).json({
    error: {
      code,
      message,
      requestId: req.id,
      ...(details !== undefined && { details }),
    },
  });
}

function toHttpError(err) {
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message, details: err.details };
  }
  // Errors raised by express.json() (body-parser) carry a `type`.
  if (err?.type === "entity.too.large") {
    return { statusCode: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" };
  }
  if (err?.type === "entity.parse.failed") {
    return { statusCode: 400, code: "INVALID_JSON", message: "Request body is not valid JSON" };
  }
  return { statusCode: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}
