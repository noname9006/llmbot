import { config, resolveDynamicPrompt } from "../config.js";
import { logger } from "../logger.js";
import { getMcpContextBlock } from "./mcpService.js";

// Histories inactive for longer than this are evicted by cleanup()
const HISTORY_TTL_MS = 24 * 60 * 60_000; // 24 hours

/**
 * Rough token estimator: 1 token ≈ 4 chars.
 * This is a simple approximation and may differ from actual tokenization,
 * especially for non-English text or content with many special characters.
 * It is intentionally conservative — good enough for throttling purposes.
 */
function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

/**
 * Drops the oldest user+assistant pairs until the estimated token count
 * fits within budget. Always keeps: system prompt + last user message.
 * Logs a warning when turns are dropped.
 * @param {Array<{role,content}>} messages  - first element must be system message
 * @param {number} budget
 * @returns {Array<{role,content}>}
 */
function trimToTokenBudget(messages, budget) {
  const [system, ...turns] = messages;
  const before = estimateTokens(messages);
  let dropped = 0;
  while (turns.length > 1 && estimateTokens([system, ...turns]) > budget) {
    // Remove the oldest user+assistant pair (2 messages) when turns[1] is an
    // assistant reply, confirming a complete pair. Otherwise remove only the
    // lone leading user message.
    const removeCount = turns[1]?.role === "assistant" ? 2 : 1;
    turns.splice(0, removeCount);
    dropped += removeCount;
  }
  if (dropped > 0) {
    logger.warn(
      `[historyService] trimToTokenBudget: dropped ${dropped} turn(s) — was ~${before} tokens, budget ${budget}`
    );
  }
  return [system, ...turns];
}

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
   * prepended as the first message. If maxInputTokens > 0, trims the oldest
   * history pairs to fit within the token budget.
   * @param {string} userId
   * @param {string} [systemPrompt]
   * @param {number} [maxInputTokens]  0 = no limit
   * @returns {Array<{role: string, content: string}>}
   */
  getMessages(userId, systemPrompt = config.llm.systemPrompt, maxInputTokens = 0) {
    this.#touch(userId);
    const history = this.#store.get(userId) ?? [];
    const messages = [
      { role: "system", content: resolveDynamicPrompt(systemPrompt, getMcpContextBlock()) },
      ...history,
    ];
    if (maxInputTokens <= 0) return messages;
    return trimToTokenBudget(messages, maxInputTokens);
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
