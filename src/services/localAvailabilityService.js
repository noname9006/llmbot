import { config } from "../config.js";
import { logger } from "../logger.js";
import { resetActiveModelOnReconnect, getLocalModelReady, ensureLocalModel } from "./agentService.js";
import { warmupLocalModel } from "./vpsLlamaProcess.js";
import {
  setLocalPresenceIdle,
  setLocalPresenceDnd,
} from "./localPresenceService.js";

// ── Agent availability ────────────────────────────────────────────────────────

let isAgentOnline = false;
let agentPollTimer = null;
let vpsPollTimer = null;
let orLocalPollTimer = null;
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
      // Proactively start the model and run the system-prompt warmup so
      // isLocalAvailable() becomes true without waiting for the first handoff.
      // Presence flips to Idle only after warmup succeeds so it accurately
      // reflects that the model is ready to handle requests.
      ensureLocalModel()
        .then(() => warmupLocalModel())
        .then(() => { if (getLocalModelReady()) setLocalPresenceIdle(); })
        .catch((err) => logger.warn(`Local model proactive warmup failed: ${err.message}`));
    } else {
      agentOfflineSince = Date.now();
      agentOnlineSince = null;
      logger.info("Local agent: online → offline");
      // Only go DND if OR local is also unavailable
      if (!isOrLocalOnline) setLocalPresenceDnd();
    }
  }
}

// ── OpenRouter local-role health ──────────────────────────────────────────────
// Tracks whether the OpenRouter API is reachable and the key is valid.
// Mirrors the agent polling logic: online→Idle, offline→DND (when agent is
// also offline so we don't over-suppress presence).

let isOrLocalOnline = false;

/**
 * Returns true when the local role's OpenRouter backend is configured AND
 * currently responding to health checks.
 */
export function isOrLocalAvailable() {
  return isOrLocalOnline;
}

/**
 * Convenience check: is OpenRouter configured for the local role?
 * (enabled flag + non-empty API key).
 * @returns {boolean}
 */
function isOrLocalCandidate() {
  return Boolean(config.openrouter?.local?.enabled && config.openrouter?.apiKey);
}

/**
 * Performs a single health check against OpenRouter for the local role.
 * Uses GET /models with the API key — lightweight, no token spend.
 */
async function pollOrLocal() {
  if (!isOrLocalCandidate()) {
    isOrLocalOnline = false;
    return;
  }

  const wasOnline = isOrLocalOnline;
  try {
    const res = await fetch(`${config.openrouter.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    isOrLocalOnline = res.ok;
  } catch {
    isOrLocalOnline = false;
  }

  if (wasOnline !== isOrLocalOnline) {
    if (isOrLocalOnline) {
      logger.info("OpenRouter local backend: offline → online");
      // Show as available if the agent is also offline (otherwise agent already set Idle)
      if (!isAgentOnline || !getLocalModelReady()) setLocalPresenceIdle();
    } else {
      logger.info("OpenRouter local backend: online → offline");
      // Only go DND when the agent is also unavailable
      if (!isAgentOnline || !getLocalModelReady()) setLocalPresenceDnd();
    }
  }
}

/**
 * Starts the agent, VPS, and OpenRouter-local polling loops.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startPolling() {
  if (agentPollTimer !== null) return;

  // Immediate first poll
  pollAgent().catch((err) => logger.warn("Agent availability poll error:", err.message));
  pollVps().catch((err) => logger.warn("VPS availability poll error:", err.message));
  pollOrLocal().catch((err) => logger.warn("OR-local availability poll error:", err.message));

  agentPollTimer = setInterval(() => {
    pollAgent().catch((err) => logger.warn("Agent availability poll error:", err.message));
  }, config.availability.pollIntervalMs);

  vpsPollTimer = setInterval(() => {
    pollVps().catch((err) => logger.warn("VPS availability poll error:", err.message));
  }, config.availability.pollIntervalMs);

  orLocalPollTimer = setInterval(() => {
    pollOrLocal().catch((err) => logger.warn("OR-local availability poll error:", err.message));
  }, config.availability.pollIntervalMs);
}

/**
 * Returns the cached availability state of the local role.
 * True when either:
 *   - The Tailscale agent is online AND the local model has completed warmup, OR
 *   - The OpenRouter local backend is configured and currently reachable.
 * @returns {boolean}
 */
export function isLocalAvailable() {
  return (isAgentOnline && getLocalModelReady()) || isOrLocalOnline;
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
