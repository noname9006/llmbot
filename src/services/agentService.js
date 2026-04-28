import { config } from "../config.js";
import { logger } from "../logger.js";

// Which local model is currently loaded: null | 'local'
let activeLocalModel = null;

// Idle timer reference for the local model
let localIdleTimer = null;

// Monotonically-increasing counter; incremented on every reconnect.
// Each pendingSwitch closure captures the generation at creation time and
// guards its state-update callbacks so a stale in-flight /start cannot
// overwrite the null that resetActiveModelOnReconnect() just set.
let generation = 0;

// Timeout for model start requests — loading a large model can take a while
const START_TIMEOUT_MS = 120_000;

// Single in-flight switch promise shared across all concurrent callers.
// This ensures only one /start call runs at a time, and the circuit breaker
// failure counter reflects the true number of distinct attempts (not the
// number of concurrent callers that happened to observe the same failure).
let pendingSwitch = null;

// ── Circuit breaker ───────────────────────────────────────────────────────────
// Prevents thundering-herd load on a struggling agent by temporarily stopping
// all /start attempts after repeated consecutive failures.

const CIRCUIT_FAILURE_THRESHOLD = 3;     // open after this many consecutive failures
const CIRCUIT_RECOVERY_MS = 2 * 60_000; // stay open for 2 minutes before half-opening

let circuitState = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
let consecutiveFailures = 0;
let circuitOpenedAt = 0;

function recordCircuitSuccess() {
  consecutiveFailures = 0;
  if (circuitState !== "CLOSED") {
    logger.info("Agent circuit breaker: CLOSED (recovered)");
    circuitState = "CLOSED";
  }
}

function recordCircuitFailure() {
  consecutiveFailures++;
  if (circuitState === "HALF_OPEN" || consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    if (circuitState !== "OPEN") {
      logger.warn(
        `Agent circuit breaker: OPEN after ${consecutiveFailures} consecutive failure(s) — ` +
          `pausing local model attempts for ${CIRCUIT_RECOVERY_MS / 1000}s`
      );
    }
    circuitState = "OPEN";
    circuitOpenedAt = Date.now();
  }
}

function checkCircuit() {
  if (circuitState === "CLOSED") return; // allow
  if (circuitState === "OPEN") {
    if (Date.now() - circuitOpenedAt >= CIRCUIT_RECOVERY_MS) {
      circuitState = "HALF_OPEN";
      logger.info("Agent circuit breaker: HALF_OPEN (testing)");
    } else {
      const remaining = Math.ceil(
        (CIRCUIT_RECOVERY_MS - (Date.now() - circuitOpenedAt)) / 1000
      );
      throw new Error(
        `Agent circuit breaker is OPEN — retry in ~${remaining}s`
      );
    }
  }
  // HALF_OPEN: allow one probe through
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns which local model is currently active.
 * @returns {null | 'local'}
 */
export function getActiveLocalModel() {
  return activeLocalModel;
}

/**
 * Called by localAvailabilityService when the agent transitions offline→online.
 * Resets the cached model state so the next request triggers a fresh /start.
 */
export function resetActiveModelOnReconnect() {
  if (activeLocalModel !== null) {
    logger.info(
      `Agent reconnected — resetting cached model state (was "${activeLocalModel}")`
    );
    activeLocalModel = null;
  }
  // Increment generation so any in-flight pendingSwitch callbacks from the
  // previous connection become no-ops and cannot re-set activeLocalModel.
  generation++;
  // Also reset the circuit breaker so the fresh connection gets a clean slate
  consecutiveFailures = 0;
  circuitState = "CLOSED";
  // Discard any in-flight switch that was targeting the now-disconnected agent
  pendingSwitch = null;
}

/**
 * Ensures the local model is the active local model.
 * Concurrent callers share a single in-flight /start promise so only one
 * request reaches the agent at a time and the circuit-breaker counts each
 * distinct switch attempt (not the number of concurrent waiters).
 * Resets the local idle timer if configured.
 */
export async function ensureLocalModel() {
  resetLocalIdleTimer();

  while (activeLocalModel !== "local") {
    if (pendingSwitch) {
      // Wait for the in-flight switch; re-evaluate afterwards.
      await pendingSwitch.catch(() => {});
      continue;
    }

    const gen = generation; // capture before going async
    logger.debug("ensureLocalModel: starting /start for local model");
    const p = agentStart(config.llama.localModelFile, {
      role: "local",
      extraArgs: config.llama.extraArgsLocal,
      contextSize: config.llama.contextSizeLocal,
    })
      .then(() => {
        if (generation === gen) activeLocalModel = "local";
        else logger.debug("ensureLocalModel: skipping stale state update (generation changed)");
      })
      .catch((err) => {
        if (generation === gen) activeLocalModel = null;
        else logger.debug("ensureLocalModel: skipping stale error reset (generation changed)");
        throw err;
      })
      .finally(() => {
        if (pendingSwitch === p) pendingSwitch = null;
      });
    pendingSwitch = p;

    await pendingSwitch; // throws on failure, propagating to the caller
  }
}

/**
 * Resets (or starts) the local model idle timer.
 * When it fires, the agent is asked to stop llama-server.
 * Only active when LOCAL_MODEL_IDLE_MS > 0.
 */
export function resetLocalIdleTimer() {
  const idleMs = config.localPresence.idleMs;
  if (!idleMs || idleMs <= 0) return; // 0 = no auto-stop

  clearLocalIdleTimer();
  localIdleTimer = setTimeout(() => {
    if (activeLocalModel !== "local") {
      localIdleTimer = null;
      return;
    }
    logger.info("Local model idle timeout — stopping local llama-server");
    activeLocalModel = null;
    localIdleTimer = null;
    agentStop().catch((err) => {
      logger.warn(`Local idle timer: agentStop failed: ${err.message}`);
    });
  }, idleMs);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Cancels the local model idle timer without stopping llama-server.
 * Called during graceful shutdown so the idle callback cannot fire and
 * attempt an agentStop() after the process has already begun tearing down.
 */
export function clearLocalIdleTimer() {
  if (localIdleTimer !== null) {
    clearTimeout(localIdleTimer);
    localIdleTimer = null;
  }
}

/**
 * Sends a POST /start request to the local agent.
 * The agent stops any running llama-server and starts a new one with the
 * specified model file.  Waits up to START_TIMEOUT_MS for the model to load.
 *
 * @param {string} modelFile  - filename (e.g. "model.gguf"), looked up in the
 *                              agent's configured model directory
 * @param {object} [options]
 * @param {string} [options.role]         - model role ("local"), used by the
 *                                          agent to apply per-model env var overrides
 * @param {string} [options.extraArgs]    - extra CLI args forwarded to llama-server
 * @param {number} [options.contextSize]  - context size override (0 = server default)
 */
async function agentStart(modelFile, { role = "", extraArgs = "", contextSize = 0 } = {}) {
  const { agentUrl, agentToken } = config.llama;
  if (!agentUrl) {
    throw new Error("LOCAL_AGENT_URL is not configured");
  }
  if (!modelFile) {
    throw new Error("Model file is not configured");
  }

  // Check circuit breaker before attempting the call
  checkCircuit();

  logger.info(`Agent: starting model "${modelFile}"`);
  const done = logger.timer(`Agent /start (${modelFile})`, "info");

  // Build the request body; only include optional fields when non-empty/non-zero
  const body = { model: modelFile };
  if (role) body.role = role;
  if (extraArgs) body.extraArgs = extraArgs;
  if (contextSize > 0) body.contextSize = contextSize;

  try {
    const res = await fetch(`${agentUrl}/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(agentToken ? { Authorization: `Bearer ${agentToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(unable to read error details)");
      throw new Error(
        `Agent /start failed: ${res.status} ${res.statusText} — ${text}`
      );
    }

    done();
    recordCircuitSuccess();
    logger.info(`Agent: model "${modelFile}" is ready`);
  } catch (err) {
    recordCircuitFailure();
    throw err;
  }
}

/**
 * Sends a POST /stop request to the local agent, killing the llama-server.
 */
async function agentStop() {
  const { agentUrl, agentToken } = config.llama;
  if (!agentUrl) return;

  logger.info("Agent: stopping local llama-server");
  try {
    const res = await fetch(`${agentUrl}/stop`, {
      method: "POST",
      headers: {
        ...(agentToken ? { Authorization: `Bearer ${agentToken}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(`Agent /stop returned ${res.status}: ${text}`);
    }
  } catch (err) {
    logger.warn(`Failed to stop local llama-server: ${err.message}`);
  }
}

