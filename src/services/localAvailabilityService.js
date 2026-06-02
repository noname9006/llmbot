import { config } from "../config.js";
import { logger } from "../logger.js";
import { resetActiveModelOnReconnect, getLocalModelReady } from "./agentService.js";
import {
  setLocalPresenceIdle,
  setLocalPresenceDnd,
} from "./localPresenceService.js";

// ── Agent availability ────────────────────────────────────────────────────────

let isAgentOnline = false;
let agentPollTimer = null;
let vpsPollTimer = null;
/** Timestamp (ms) when the agent last went offline, or null if currently online */
let agentOfflineSince = null;
/** Timestamp (ms) when the agent last came online, or null if currently offline */
let agentOnlineSince = null;

/**
 * Performs a single health check against the local agent.
 * Updates the cached state and logs any transitions.
 */
async function pollAgent() {
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
    if (res.ok) {
      const data = await res.json();
      // Consider local available whenever the agent process is reachable and healthy.
      // Model loading is handled on-demand by switchToCommon() / switchToHeavy().
      // Agent /health returns: { status: "ok", running: boolean, model: string|null }
      isAgentOnline = data.status === "ok";
    } else {
      isAgentOnline = false;
    }
  } catch {
    isAgentOnline = false;
  }

  if (wasOnline !== isAgentOnline) {
    if (isAgentOnline) {
      agentOnlineSince = Date.now();
      agentOfflineSince = null;
      logger.info("Local agent: offline → online");
      // Reset cached model state so the next request triggers a fresh /start
      resetActiveModelOnReconnect();
      // Update local bot presence to Idle while the next request loads the model
      setLocalPresenceIdle();
    } else {
      agentOfflineSince = Date.now();
      agentOnlineSince = null;
      logger.info("Local agent: online → offline");
      // Update local bot presence to DND (model unavailable)
      setLocalPresenceDnd();
    }
  }
}

/**
 * Starts the agent and VPS polling loops.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startPolling() {
  if (agentPollTimer !== null) return;

  // Immediate first poll
  pollAgent().catch((err) => logger.warn("Agent availability poll error:", err.message));
  pollVps().catch((err) => logger.warn("VPS availability poll error:", err.message));

  agentPollTimer = setInterval(() => {
    pollAgent().catch((err) => logger.warn("Agent availability poll error:", err.message));
  }, config.availability.pollIntervalMs);

  vpsPollTimer = setInterval(() => {
    pollVps().catch((err) => logger.warn("VPS availability poll error:", err.message));
  }, config.availability.pollIntervalMs);
}

/**
 * Returns the cached availability state of the local agent.
 * Returns true only when the agent is online AND the model has completed warmup.
 * @returns {boolean}
 */
export function isLocalAvailable() {
  return isAgentOnline && getLocalModelReady();
}

/**
 * Returns how long (in ms) the local agent has been offline, or 0 if online.
 * @returns {number}
 */
export function agentOfflineDurationMs() {
  if (isAgentOnline || agentOfflineSince === null) return 0;
  return Date.now() - agentOfflineSince;
}

/**
 * Returns how long (in ms) the local agent has been online, or 0 if offline.
 * @returns {number}
 */
export function agentOnlineDurationMs() {
  if (!isAgentOnline || agentOnlineSince === null) return 0;
  return Date.now() - agentOnlineSince;
}

// ── VPS health ────────────────────────────────────────────────────────────────

let isVpsOnline = false;

async function pollVps() {
  const vpsUrl = config.llama.remoteUrl;
  if (!vpsUrl) {
    isVpsOnline = false;
    return;
  }

  const wasOnline = isVpsOnline;
  try {
    // /models is a lightweight OpenAI-compat liveness endpoint
    const res = await fetch(`${vpsUrl}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    isVpsOnline = res.ok;
  } catch {
    isVpsOnline = false;
  }

  if (wasOnline !== isVpsOnline) {
    if (isVpsOnline) {
      logger.info("Remote llama-server: offline → online");
    } else {
      logger.warn("Remote llama-server: online → offline (fallback route is down!)");
    }
  }
}

/**
 * Returns the cached availability state of the VPS llama-server.
 * @returns {boolean}
 */
export function isVpsAvailable() {
  return isVpsOnline;
}
