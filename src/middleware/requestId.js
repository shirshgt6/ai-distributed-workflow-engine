import { randomUUID } from "node:crypto";

const HEADER = "x-request-id";
// Only accept "boring" ids from callers. The value ends up in logs and
// response headers, so an attacker-controlled huge or weird string
// (newlines, control chars) must not pass through.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Correlation ID: one id that follows a request everywhere it goes.
 *
 * If an upstream (gateway, another service, the client) already sent an
 * X-Request-Id we reuse it, so logs across services can be joined on it.
 * Otherwise we mint one. Later phases will copy this id into queued tasks
 * and Kafka events so one user action can be traced API -> Redis -> worker.
 */
export function requestId(req, res, next) {
  const incoming = req.get(HEADER);
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.set(HEADER, req.id);
  next();
}
