import { config } from "../config.js";
import { logger } from "../logger.js";

let isAgentOnline = false;
let pollTimer = null;

/**
 * Performs a single health check against the local agent.
 * Updates the cached state and logs any transitions.
 */
async function poll() {
  const wasOnline = isAgentOnline;
  const { agentUrl, agentToken } = config.llama;

  if (!agentUrl) {
    // No agent configured — local is never available
    isAgentOnline = false;
    return;
  }

  try {
    const res = await fetch(`${agentUrl}/health`, {
      headers: agentToken ? { Authorization: `Bearer ${agentToken}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    isAgentOnline = res.ok;
  } catch {
    isAgentOnline = false;
  }

  if (wasOnline !== isAgentOnline) {
    if (isAgentOnline) {
      logger.info("Local agent: offline → online");
    } else {
      logger.info("Local agent: online → offline");
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
 * Returns the cached availability state of the local agent.
 * @returns {boolean}
 */
export function isLocalAvailable() {
  return isAgentOnline;
}
