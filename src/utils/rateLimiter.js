/**
 * Per-user sliding-window rate limiter and global concurrency semaphore.
 */

/**
 * Creates a per-user sliding-window rate limiter.
 *
 * @param {object} opts
 * @param {number} opts.maxRequests  - max allowed requests per window
 * @param {number} opts.windowMs     - sliding window duration in ms
 */
export function createRateLimiter({ maxRequests, windowMs }) {
  /** @type {Map<string, number[]>} userId → array of request timestamps */
  const windows = new Map();

  /**
   * Returns true if the request is allowed; records it if so.
   * @param {string} userId
   * @returns {boolean}
   */
  function check(userId) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (windows.get(userId) ?? []).filter((t) => t > cutoff);
    if (timestamps.length >= maxRequests) {
      windows.set(userId, timestamps);
      return false;
    }
    timestamps.push(now);
    windows.set(userId, timestamps);
    return true;
  }

  /**
   * Returns milliseconds until the user's oldest in-window request expires.
   * Returns 0 if they are not currently rate-limited.
   * @param {string} userId
   * @returns {number}
   */
  function retryAfterMs(userId) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (windows.get(userId) ?? []).filter((t) => t > cutoff);
    if (timestamps.length < maxRequests) return 0;
    return timestamps[0] + windowMs - now;
  }

  return { check, retryAfterMs };
}

/**
 * Simple promise-based semaphore for global concurrency control.
 * @param {number} maxConcurrent
 */
export function createSemaphore(maxConcurrent) {
  let running = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  function acquire() {
    if (running < maxConcurrent) {
      running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release() {
    if (queue.length > 0) {
      const next = queue.shift();
      next();
    } else {
      running--;
    }
  }

  return {
    acquire,
    release,
    get running() {
      return running;
    },
    get queued() {
      return queue.length;
    },
  };
}
