import { config } from "../config.js";
import { logger } from "../logger.js";

// Histories inactive for longer than this are evicted by cleanup()
const HISTORY_TTL_MS = 24 * 60 * 60_000; // 24 hours

/**
 * Manages per-user conversation history.
 * Each entry: { role: "user" | "assistant", content: string }
 */
class HistoryService {
  /** @type {Map<string, Array<{role: string, content: string}>>} */
  #store = new Map();

  /** @type {Map<string, number>} userId → last-access timestamp */
  #lastAccess = new Map();

  /**
   * Returns the full message array for a user, including the system prompt
   * prepended as the first message.
   * @param {string} userId
   * @returns {Array<{role: string, content: string}>}
   */
  getMessages(userId) {
    this.#touch(userId);
    const history = this.#store.get(userId) ?? [];
    return [
      { role: "system", content: config.llm.systemPrompt },
      ...history,
    ];
  }

  /**
   * Appends a user message and trims history if needed.
   * @param {string} userId
   * @param {string} content
   */
  pushUser(userId, content) {
    this.#push(userId, "user", content);
  }

  /**
   * Appends an assistant message and trims history if needed.
   * @param {string} userId
   * @param {string} content
   */
  pushAssistant(userId, content) {
    this.#push(userId, "assistant", content);
  }

  /**
   * Removes the most recently pushed user message.
   * Use this to roll back after a failed LLM call
   * without destroying the entire conversation history.
   * @param {string} userId
   */
  popLastUser(userId) {
    const history = this.#store.get(userId);
    if (!history || history.length === 0) return;
    // Walk backwards to find and remove the last user entry
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") {
        history.splice(i, 1);
        break;
      }
    }
  }

  /**
   * Clears history for a user.
   * @param {string} userId
   */
  reset(userId) {
    this.#store.delete(userId);
    this.#lastAccess.delete(userId);
  }

  /**
   * Returns the number of users currently tracked.
   */
  get size() {
    return this.#store.size;
  }

  /**
   * Removes entries for users who have been inactive for longer than HISTORY_TTL_MS.
   * Call periodically to prevent unbounded Map growth.
   */
  cleanup() {
    const cutoff = Date.now() - HISTORY_TTL_MS;
    for (const [userId, ts] of this.#lastAccess) {
      if (ts < cutoff) {
        this.#store.delete(userId);
        this.#lastAccess.delete(userId);
      }
    }
  }

  // ─── private ────────────────────────────────────────────────────────────────

  #touch(userId) {
    this.#lastAccess.set(userId, Date.now());
  }

  #push(userId, role, content) {
    this.#touch(userId);
    if (!this.#store.has(userId)) {
      this.#store.set(userId, []);
    }
    const history = this.#store.get(userId);
    history.push({ role, content });
    this.#trim(userId);
  }

  #trim(userId) {
    const history = this.#store.get(userId);
    if (!history) return;

    // Keep only the last N user+assistant pairs (2 messages per pair)
    const maxMessages = config.history.maxPairs * 2;
    if (history.length > maxMessages) {
      history.splice(0, history.length - maxMessages);
    }

    // After an even-count trim the oldest remaining message might be an
    // assistant turn (if the conversation started mid-pair or was corrupted).
    // Most inference backends reject history that does not start with a user
    // message, so remove any leading assistant entries in a single splice.
    let firstUserIdx = 0;
    while (firstUserIdx < history.length && history[firstUserIdx].role !== "user") {
      firstUserIdx++;
    }
    if (firstUserIdx > 0) {
      logger.warn(
        `HistoryService: removed ${firstUserIdx} leading assistant turn(s) for user ${userId} — possible history corruption`
      );
      history.splice(0, firstUserIdx);
    }
  }
}

export const historyService = new HistoryService();
