import { config } from "../config.js";
import { logger } from "../logger.js";

/** @type {import("discord.js").Client | null} */
let localClient = null;

/** Timer reference for the post-task cooldown back to Idle */
let cooldownTimer = null;

/**
 * Registers the local bot client so presence updates can be applied to it.
 * Call this from the localClient `ready` handler.
 *
 * @param {import("discord.js").Client} client
 */
export function setLocalClient(client) {
  localClient = client;
}

/**
 * Sets the local bot presence to Idle.
 * Represents: local model is healthy but not currently processing a task.
 */
export function setLocalPresenceIdle() {
  if (!localClient?.isReady()) return;
  logger.info("[localPresence] Setting presence: Idle");
  localClient.user.setPresence({ status: "idle" });
}

/**
 * Sets the local bot presence to Online.
 * Represents: local model is actively processing a task.
 */
export function setLocalPresenceOnline() {
  if (!localClient?.isReady()) return;
  logger.info("[localPresence] Setting presence: Online");
  localClient.user.setPresence({ status: "online" });
}

/**
 * Sets the local bot presence to Do Not Disturb.
 * Represents: local model is unavailable / agent offline.
 */
export function setLocalPresenceDnd() {
  if (!localClient?.isReady()) return;
  logger.info("[localPresence] Setting presence: Do Not Disturb");
  localClient.user.setPresence({ status: "dnd" });
}

/**
 * Sets presence to Online immediately, then schedules a return to Idle after
 * `LOCAL_PRESENCE_COOLDOWN_MS`.  Any existing cooldown timer is reset.
 * If the cooldown is 0 or negative the transition to Idle is immediate.
 */
export function setLocalPresenceCooldown() {
  if (!localClient?.isReady()) return;

  setLocalPresenceOnline();

  // Cancel any existing cooldown so the timer always measures from the most
  // recent task completion.
  if (cooldownTimer !== null) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }

  const cooldownMs = config.localPresence.cooldownMs;
  if (cooldownMs > 0) {
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      setLocalPresenceIdle();
    }, cooldownMs);
  } else {
    setLocalPresenceIdle();
  }
}
