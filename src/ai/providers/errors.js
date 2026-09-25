/**
 * Every provider failure is normalised to this, so callers (retry logic,
 * fallback, the task engine) never need to know provider-specific errors.
 *
 * retryable:
 *   true  -> network error, timeout, 429 rate limit, 5xx: try again / fall back
 *   false -> 400 bad request, 401/403 auth, 404 unknown model: retrying won't help
 */
export class ProviderError extends Error {
  constructor(message, { provider, status = null, retryable, cause } = {}) {
    super(message, { cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
