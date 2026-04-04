import { config } from "../config.js";
import { logger } from "../logger.js";

// Which local model is currently loaded: null | 'common' | 'heavy'
let activeLocalModel = null;

// Idle timer reference for Model 3 (heavy)
let heavyIdleTimer = null;

const HEAVY_IDLE_MS = 15 * 60 * 1000; // 15 minutes

// Timeout for model start requests — loading a large model can take a while
const START_TIMEOUT_MS = 120_000;

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
 * @returns {null | 'common' | 'heavy'}
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
  // Also reset the circuit breaker so the fresh connection gets a clean slate
  consecutiveFailures = 0;
  circuitState = "CLOSED";
}

/**
 * Ensures Model 2 (common) is the active local model.
 * Skips the /start call if the correct model is already loaded.
 * Clears the heavy idle timer if it was running.
 */
export async function switchToCommon() {
  clearHeavyIdleTimer();
  if (activeLocalModel === "common") {
    logger.debug("switchToCommon: common model already loaded, skipping /start");
    return;
  }
  await agentStart(config.llama.localModelCommonFile);
  activeLocalModel = "common";
}

/**
 * Ensures Model 3 (heavy) is the active local model.
 * Asks the agent to (re)start llama-server with the heavy model.
 * Starts the 15-minute idle timer.
 */
export async function switchToHeavy() {
  if (activeLocalModel === "heavy") {
    logger.debug("switchToHeavy: heavy model already loaded, skipping /start");
    resetHeavyIdleTimer();
    return;
  }
  await agentStart(config.llama.localModelHeavyFile);
  activeLocalModel = "heavy";
  resetHeavyIdleTimer();
}

/**
 * Resets (or starts) the 15-minute idle timer for Model 3.
 * When it fires, the agent is asked to stop llama-server.
 */
export function resetHeavyIdleTimer() {
  clearHeavyIdleTimer();
  heavyIdleTimer = setTimeout(() => {
    if (activeLocalModel !== "heavy") {
      heavyIdleTimer = null;
      return;
    }
    logger.info("Heavy model idle timeout — stopping local llama-server");
    activeLocalModel = null;
    heavyIdleTimer = null;
    agentStop().catch((err) => {
      logger.warn(`Idle timer: agentStop failed: ${err.message}`);
    });
  }, HEAVY_IDLE_MS);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function clearHeavyIdleTimer() {
  if (heavyIdleTimer !== null) {
    clearTimeout(heavyIdleTimer);
    heavyIdleTimer = null;
  }
}

/**
 * Sends a POST /start request to the local agent.
 * The agent stops any running llama-server and starts a new one with the
 * specified model file.  Waits up to START_TIMEOUT_MS for the model to load.
 *
 * @param {string} modelFile  - filename (e.g. "model.gguf"), looked up in the
 *                              agent's configured model directory
 */
async function agentStart(modelFile) {
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

  try {
    const res = await fetch(`${agentUrl}/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(agentToken ? { Authorization: `Bearer ${agentToken}` } : {}),
      },
      body: JSON.stringify({ model: modelFile }),
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
    // Ensure activeLocalModel is not left in a stale state on failure
    activeLocalModel = null;
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

