import { config } from "../config.js";
import { logger } from "../logger.js";

// Which local model is currently loaded: null | 'common' | 'heavy'
let activeLocalModel = null;

// Idle timer reference for Model 3 (heavy)
let heavyIdleTimer = null;

const HEAVY_IDLE_MS = 15 * 60 * 1000; // 15 minutes

// Timeout for model start requests — loading a large model can take a while
const START_TIMEOUT_MS = 120_000;

/**
 * Returns which local model is currently active.
 * @returns {null | 'common' | 'heavy'}
 */
export function getActiveLocalModel() {
  return activeLocalModel;
}

/**
 * Ensures Model 2 (common) is the active local model.
 * Asks the agent to (re)start llama-server with the common model.
 * Clears the heavy idle timer if it was running.
 */
export async function switchToCommon() {
  clearHeavyIdleTimer();
  await agentStart(config.llama.localModelCommonFile);
  activeLocalModel = "common";
}

/**
 * Ensures Model 3 (heavy) is the active local model.
 * Asks the agent to (re)start llama-server with the heavy model.
 * Starts the 15-minute idle timer.
 */
export async function switchToHeavy() {
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
  heavyIdleTimer = setTimeout(async () => {
    if (activeLocalModel !== "heavy") {
      heavyIdleTimer = null;
      return;
    }
    logger.info("Heavy model idle timeout — stopping local llama-server");
    activeLocalModel = null;
    heavyIdleTimer = null;
    await agentStop();
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

  logger.info(`Agent: starting model "${modelFile}"`);

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

  logger.info(`Agent: model "${modelFile}" is ready`);
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
