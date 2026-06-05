import { logger } from "../logger.js";

/**
 * Retry a function with exponential backoff + jitter.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.initialDelayMs=500]
 * @param {number} [opts.maxDelayMs=10000]
 * @param {number} [opts.rateLimitDelayMs=5000] - fixed delay for 429 rate limit errors
 * @param {(err: Error, attempt: number) => boolean} [opts.shouldRetry]  - return false to abort early
 * @param {string} [opts.label]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 10_000,
    rateLimitDelayMs = 5_000,
    shouldRetry = () => true,
    label = "operation",
  } = opts;

  if (maxAttempts < 1) {
    throw new Error(`${label}: maxAttempts must be at least 1 (got ${maxAttempts})`);
  }

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      // Use fixed delay for 429 rate limit errors, exponential backoff otherwise.
      // Honour a server-supplied Retry-After value when present (e.g. from OpenRouter).
      const isRateLimit = err.statusCode === 429;
      // Server-supplied value is already validated/capped by the caller; do NOT
      // apply maxDelayMs on top of it — that would defeat the header's purpose.
      const serverSuppliedDelay = isRateLimit && err.retryAfterMs != null;
      const base = isRateLimit
        ? (err.retryAfterMs ?? rateLimitDelayMs)
        : initialDelayMs * 2 ** (attempt - 1);
      const jitter = isRateLimit ? 0 : Math.random() * base * 0.5;
      const delay = serverSuppliedDelay
        ? base
        : Math.min(base + jitter, maxDelayMs);
      logger.warn(
        `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay)}ms: ${err.message}`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
