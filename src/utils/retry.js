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
 * @param {(err: Error, attempt: number) => boolean} [opts.shouldRetry]  - return false to abort early
 * @param {string} [opts.label]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 10_000,
    shouldRetry = () => true,
    label = "operation",
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      // Exponential backoff with ±50 % jitter to avoid thundering herd
      const base = initialDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * base * 0.5;
      const delay = Math.min(base + jitter, maxDelayMs);
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
