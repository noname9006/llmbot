import { config } from "../config.js";

/**
 * Manages per-user conversation history.
 * Each entry: { role: "user" | "assistant", content: string }
 */
class HistoryService {
  /** @type {Map<string, Array<{role: string, content: string}>>} */
  #store = new Map();

  /**
   * Returns the full message array for a user, including the system prompt
   * prepended as the first message.
   * @param {string} userId
   * @returns {Array<{role: string, content: string}>}
   */
  getMessages(userId) {
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
  }

  /**
   * Returns the number of users currently tracked.
   */
  get size() {
    return this.#store.size;
  }

  // ─── private ────────────────────────────────────────────────────────────────

  #push(userId, role, content) {
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
  }
}

export const historyService = new HistoryService();
