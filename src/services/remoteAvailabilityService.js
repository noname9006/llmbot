import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  startVpsLlamaServer,
  stopVpsLlamaServer,
  warmupRemoteModel,
  isVpsServerRunning,
} from "./vpsLlamaProcess.js";
import { resetAllCircuits } from "./backendRouter.js";

let monitorTimer = null;

// Tracks whether OR was unreachable on the last poll, so we can detect the
// down→up transition and reset circuit breakers exactly once on recovery.
let wasOrDown = false;

/**
 * Returns true when the remote role is configured to use OpenRouter as its
 * primary backend (OPENROUTER_REMOTE_PRIORITY=openrouter).
 */
function isOrRemotePriority() {
  return Boolean(
    config.openrouter?.remote?.enabled &&
    config.openrouter?.apiKey &&
    config.openrouter.remote.priority === "openrouter"
  );
}

/**
 * Single lightweight health check against OpenRouter for the remote role.
 * Uses GET /models — no token spend, just confirms reachability + key validity.
 * @returns {Promise<boolean>}
 */
async function checkOrRemoteHealth() {
  try {
    const res = await fetch(`${config.openrouter.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Starts the VPS llama-server if not already running.
 * Errors (e.g. binary missing, model load timeout) are logged but not re-thrown
 * so the monitor keeps running.
 */
async function ensureVpsRunning() {
  if (isVpsServerRunning()) return;
  logger.info("[remoteAvailability] OpenRouter unreachable — starting VPS llama-server as fallback");
  try {
    await startVpsLlamaServer();
    await warmupRemoteModel();
  } catch (err) {
    logger.error(`[remoteAvailability] Failed to start VPS fallback: ${err.message}`);
  }
}

/**
 * Stops the VPS llama-server if it is running.
 */
async function ensureVpsStopped() {
  if (!isVpsServerRunning()) return;
  logger.info("[remoteAvailability] OpenRouter is back — stopping VPS llama-server");
  await stopVpsLlamaServer();
}

/**
 * Single monitor poll: checks OR health and starts/stops VPS accordingly.
 * Resets all circuit breakers when OR transitions down→up so the next request
 * uses OR immediately instead of waiting for the 60-min circuit window.
 */
async function pollOrRemote() {
  const orHealthy = await checkOrRemoteHealth();

  if (orHealthy) {
    if (wasOrDown) {
      logger.info("[remoteAvailability] OpenRouter is back online");
      wasOrDown = false;
      resetAllCircuits();
    }
    await ensureVpsStopped();
  } else {
    if (!wasOrDown) {
      logger.warn("[remoteAvailability] OpenRouter unreachable — VPS will serve as fallback");
      wasOrDown = true;
    }
    await ensureVpsRunning();
  }
}

/**
 * Starts the periodic OpenRouter health monitor.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
function startOrRemoteMonitor() {
  if (monitorTimer !== null) return;
  const intervalMs = config.remoteAvailability.monitorIntervalMs;
  if (intervalMs <= 0) return;

  monitorTimer = setInterval(() => {
    pollOrRemote().catch((err) =>
      logger.warn(`[remoteAvailability] Monitor error: ${err.message}`)
    );
  }, intervalMs);

  logger.info(
    `[remoteAvailability] OR monitor started (interval: ${intervalMs / 1000}s)`
  );
}

/**
 * Stops the periodic OpenRouter health monitor.
 * Call during graceful shutdown.
 */
export function stopOrRemoteMonitor() {
  if (monitorTimer !== null) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

/**
 * Initializes the remote inference backend.
 *
 * Standard mode (OPENROUTER_REMOTE_PRIORITY != openrouter):
 *   Starts VPS llama-server immediately, then warms it up. Existing behaviour.
 *
 * OR-priority mode (OPENROUTER_REMOTE_PRIORITY=openrouter):
 *   Checks OpenRouter first. Starts VPS only if OR is unreachable.
 *   Launches a periodic monitor (default every 30 min) that starts VPS when OR
 *   goes down and stops it (resetting circuit breakers) when OR recovers.
 *
 * @returns {Promise<void>}
 */
export async function initRemoteBackend() {
  if (!isOrRemotePriority() || !config.remoteAvailability.enabled) {
    await startVpsLlamaServer();
    await warmupRemoteModel();
    return;
  }

  logger.info("[remoteAvailability] OR-first mode: checking OpenRouter availability before starting VPS…");
  const orHealthy = await checkOrRemoteHealth();

  if (orHealthy) {
    logger.info("[remoteAvailability] OpenRouter accessible — skipping VPS startup");
    wasOrDown = false;
  } else {
    logger.warn("[remoteAvailability] OpenRouter not accessible — starting VPS llama-server as initial fallback");
    wasOrDown = true;
    await startVpsLlamaServer();
    await warmupRemoteModel();
  }

  startOrRemoteMonitor();
}
