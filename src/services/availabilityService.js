import { config } from "../config.js";
import { logger } from "../logger.js";

let isLocalOnline = false;
let pollTimer = null;

/**
 * Performs a single availability check against the local Ollama instance.
 * Updates the cached state and logs any transitions.
 */
async function poll() {
  const wasOnline = isLocalOnline;
  try {
    const res = await fetch(`${config.ollama.localBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    isLocalOnline = res.ok;
  } catch {
    isLocalOnline = false;
  }

  if (wasOnline !== isLocalOnline) {
    if (isLocalOnline) {
      logger.info("Local Ollama: offline → online");
    } else {
      logger.info("Local Ollama: online → offline");
    }
  }
}

/**
 * Starts the polling loop. Runs an immediate poll, then continues on interval.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startPolling() {
  if (pollTimer !== null) return;

  // Immediate first poll
  poll().catch((err) => logger.warn("Availability poll error:", err.message));

  pollTimer = setInterval(() => {
    poll().catch((err) => logger.warn("Availability poll error:", err.message));
  }, config.availability.pollIntervalMs);
}

/**
 * Returns the cached availability state of the local Ollama instance.
 * @returns {boolean}
 */
export function isLocalAvailable() {
  return isLocalOnline;
}
