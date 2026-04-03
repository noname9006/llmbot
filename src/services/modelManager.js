import { config } from "../config.js";
import { logger } from "../logger.js";
import { ollamaUnload } from "./ollamaService.js";

// Which local model is currently loaded: null | 'common' | 'heavy'
let activeLocalModel = null;

// Idle timer reference for Model 3 (heavy)
let heavyIdleTimer = null;

const HEAVY_IDLE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Returns which local model is currently active.
 * @returns {null | 'common' | 'heavy'}
 */
export function getActiveLocalModel() {
  return activeLocalModel;
}

/**
 * Unloads whichever local model is currently active, if any.
 * Clears the heavy idle timer if it was running.
 */
export async function unloadActiveLocalModel() {
  if (activeLocalModel === null) return;

  const modelName =
    activeLocalModel === "heavy"
      ? config.ollama.localModelHeavy
      : config.ollama.localModelCommon;

  clearHeavyIdleTimer();
  activeLocalModel = null;
  await ollamaUnload(config.ollama.localBaseUrl, modelName);
}

/**
 * Ensures Model 2 (common) is the active local model.
 * Unloads Model 3 first if it was loaded.
 * Does NOT actually send a load request — Ollama will auto-load on first chat call.
 */
export async function switchToCommon() {
  if (activeLocalModel === "heavy") {
    await unloadActiveLocalModel();
  }
  activeLocalModel = "common";
  clearHeavyIdleTimer();
}

/**
 * Ensures Model 3 (heavy) is the active local model.
 * Unloads Model 2 first if it was loaded.
 * The caller is responsible for sending the actual chat request with keep_alive=-1.
 */
export async function switchToHeavy() {
  if (activeLocalModel === "common") {
    await unloadActiveLocalModel();
  }
  activeLocalModel = "heavy";
  resetHeavyIdleTimer();
}

/**
 * Resets (or starts) the 15-minute idle timer for Model 3.
 * When it fires, Model 3 is unloaded.
 */
export function resetHeavyIdleTimer() {
  clearHeavyIdleTimer();
  heavyIdleTimer = setTimeout(async () => {
    // Guard: only unload if heavy model is still active when timer fires
    if (activeLocalModel !== "heavy") {
      heavyIdleTimer = null;
      return;
    }
    logger.info("Heavy model idle timeout — unloading Model 3");
    activeLocalModel = null;
    heavyIdleTimer = null;
    await ollamaUnload(config.ollama.localBaseUrl, config.ollama.localModelHeavy);
  }, HEAVY_IDLE_MS);
}

function clearHeavyIdleTimer() {
  if (heavyIdleTimer !== null) {
    clearTimeout(heavyIdleTimer);
    heavyIdleTimer = null;
  }
}
