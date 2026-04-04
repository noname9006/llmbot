import { config } from "../config.js";
import { logger } from "../logger.js";

// Which local model is currently loaded: null | 'common' | 'heavy'
let activeLocalModel = null;

// Idle timer reference for Model 3 (heavy)
let heavyIdleTimer = null;

// Monotonically-increasing counter; incremented on every reconnect.
// Each pendingSwitch closure captures the generation at creation time and
// guards its state-update callbacks so a stale in-flight /start cannot
// overwrite the null that resetActiveModelOnReconnect() just set.
let generation = 0;

const HEAVY_IDLE_MS = 15 * 60 * 1000; // 15 minutes

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
 * Ensures Model 2 (common) is the active local model.
 * Concurrent callers share a single in-flight /start promise so only one
 * request reaches the agent at a time and the circuit-breaker counts each
 * distinct switch attempt (not the number of concurrent waiters).
 * Clears the heavy idle timer if it was running.
 */
export async function switchToCommon() {
  clearHeavyIdleTimer();

  // JS single-thread guarantee: the check and pendingSwitch assignment are
  // atomic from the event-loop perspective — no other caller can sneak between
  // "pendingSwitch is null" and "pendingSwitch = …".
  while (activeLocalModel !== "common") {
    if (pendingSwitch) {
      // Wait for the in-flight switch (could be common or heavy); re-evaluate.
      await pendingSwitch.catch(() => {});
      continue;
    }

    const gen = generation; // capture before going async
    logger.debug("switchToCommon: starting /start for common model");
    // Capture the promise reference so .finally only clears pendingSwitch if
    // it still refers to THIS promise — prevents stomping a new promise that
    // was assigned after resetActiveModelOnReconnect() ran concurrently.
    const p = agentStart(config.llama.localModelCommonFile)
      .then(() => {
        if (generation === gen) activeLocalModel = "common";
        else logger.debug("switchToCommon: skipping stale state update (generation changed)");
      })
      .catch((err) => {
        if (generation === gen) activeLocalModel = null;
        else logger.debug("switchToCommon: skipping stale error reset (generation changed)");
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
 * Ensures Model 3 (heavy) is the active local model.
 * Asks the agent to (re)start llama-server with the heavy model.
 * Starts the 15-minute idle timer on success.
 * Concurrent callers share the single in-flight switch promise.
 */
export async function switchToHeavy() {
  if (activeLocalModel === "heavy") {
    resetHeavyIdleTimer();
    return;
  }

  while (activeLocalModel !== "heavy") {
    if (pendingSwitch) {
      await pendingSwitch.catch(() => {});
      continue;
    }

    const gen = generation; // capture before going async
    logger.debug("switchToHeavy: starting /start for heavy model");
    // Same reference-guard pattern as switchToCommon.
    const p = agentStart(config.llama.localModelHeavyFile)
      .then(() => {
        if (generation === gen) activeLocalModel = "heavy";
        else logger.debug("switchToHeavy: skipping stale state update (generation changed)");
      })
      .catch((err) => {
        if (generation === gen) activeLocalModel = null;
        else logger.debug("switchToHeavy: skipping stale error reset (generation changed)");
        throw err;
      })
      .finally(() => {
        if (pendingSwitch === p) pendingSwitch = null;
      });
    pendingSwitch = p;

    await pendingSwitch;
  }

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

/**
 * Cancels the Model 3 idle timer without stopping llama-server.
 * Called internally (by switchToCommon / resetHeavyIdleTimer) and exported
 * for use during graceful shutdown so the idle callback cannot fire and
 * attempt an agentStop() after the process has already begun tearing down.
 */
export function clearHeavyIdleTimer() {
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

