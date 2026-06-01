import { config } from "../config.js";
import {
  computeMessageTokenBudget,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "../utils/contextBudget.js";

function truncateString(value, maxLength) {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/**
 * Shortens a serialized tool-result envelope while keeping ok/error/tool fields.
 * @param {string} content
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateToolMessageContent(content, maxChars) {
  const text = String(content ?? "");
  if (text.length <= maxChars) return text;

  try {
    const envelope = JSON.parse(text);
    const data = envelope?.data;
    let shortenedData = data;
    if (typeof data === "string") {
      shortenedData = truncateString(data, Math.floor(maxChars * 0.6));
    } else if (data != null) {
      const serialized = JSON.stringify(data);
      shortenedData =
        serialized.length > Math.floor(maxChars * 0.5)
          ? truncateString(serialized, Math.floor(maxChars * 0.5))
          : data;
    }
    const next = {
      ...envelope,
      data: shortenedData,
      meta: { ...(envelope.meta ?? {}), truncated: true, contextTrim: true },
    };
    let out = JSON.stringify(next);
    if (out.length > maxChars) {
      out = truncateString(out, maxChars);
    }
    return out;
  } catch {
    return truncateString(text, maxChars);
  }
}

/**
 * @param {Array<object>} messages
 * @param {number|null} firstToolAssistantIndex
 * @returns {number}
 */
export function findProtectedFromIndex(messages, firstToolAssistantIndex) {
  if (
    Number.isInteger(firstToolAssistantIndex) &&
    firstToolAssistantIndex >= 1 &&
    firstToolAssistantIndex < messages.length
  ) {
    return firstToolAssistantIndex;
  }
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return Math.max(1, messages.length - 1);
}

/**
 * @param {object} params
 * @param {Array<object>} params.messages
 * @param {Array<object>} [params.tools]
 * @param {number} params.nCtx
 * @param {number} params.maxTokensOut
 * @param {number|null} [params.firstToolAssistantIndex]
 * @param {{ warn?: (msg: string) => void }} [params.logger]
 * @param {number|string} [params.round]
 * @returns {{ messages: Array<object>, stats: object }}
 */
export function trimMessagesForContext({
  messages,
  tools = [],
  nCtx,
  maxTokensOut = 0,
  firstToolAssistantIndex = null,
  logger = null,
  round = "?",
}) {
  const stats = {
    round,
    skipped: false,
    estBefore: 0,
    estAfter: 0,
    messageBudget: 0,
    droppedPrefixMessages: 0,
    truncatedToolMessages: 0,
    truncatedSystem: false,
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages ?? [], stats };
  }
  if (!nCtx || nCtx <= 0) {
    stats.skipped = true;
    stats.estBefore = estimateMessagesTokens(messages);
    stats.estAfter = stats.estBefore;
    return { messages: messages.map((m) => ({ ...m })), stats };
  }

  const trimConfig = config.contextTrim;
  const messageBudget = computeMessageTokenBudget({
    nCtx,
    maxTokensOut,
    tools,
    safetyMargin: trimConfig.safetyMargin,
    minMessageBudget: trimConfig.minMessageBudget,
  });
  stats.messageBudget = messageBudget;

  const system = { ...messages[0] };
  const protectedFrom = findProtectedFromIndex(messages, firstToolAssistantIndex);
  const prefix = messages.slice(1, protectedFrom).map((m) => ({ ...m }));
  const suffix = messages.slice(protectedFrom).map((m) => ({ ...m }));

  let candidate = [system, ...prefix, ...suffix];
  stats.estBefore = estimateMessagesTokens(candidate);

  if (stats.estBefore <= messageBudget) {
    stats.estAfter = stats.estBefore;
    return { messages: candidate, stats };
  }

  // Phase A — drop oldest messages in prefix (before current question / tool session)
  while (prefix.length > 0 && estimateMessagesTokens([system, ...prefix, ...suffix]) > messageBudget) {
    const removeCount = prefix.length > 1 && prefix[1]?.role === "assistant" ? 2 : 1;
    prefix.splice(0, removeCount);
    stats.droppedPrefixMessages += removeCount;
  }

  candidate = [system, ...prefix, ...suffix];

  // Phase B — shorten tool payloads in protected suffix (longest first)
  if (estimateMessagesTokens(candidate) > messageBudget) {
    const toolIndices = suffix
      .map((message, index) => ({ index, len: String(message.content ?? "").length, role: message.role }))
      .filter((entry) => entry.role === "tool")
      .sort((a, b) => b.len - a.len);

    for (const { index } of toolIndices) {
      if (estimateMessagesTokens(candidate) <= messageBudget) break;
      const before = String(suffix[index].content ?? "").length;
      if (before === 0) continue;
      const targetChars = Math.max(
        400,
        Math.floor(before * (messageBudget / Math.max(stats.estBefore, 1)))
      );
      suffix[index] = {
        ...suffix[index],
        content: truncateToolMessageContent(suffix[index].content, targetChars),
      };
      stats.truncatedToolMessages += 1;
      candidate = [system, ...prefix, ...suffix];
    }
  }

  // Phase C — trim long prefix turns by content length
  if (estimateMessagesTokens(candidate) > messageBudget) {
    const prefixByLen = prefix
      .map((message, index) => ({
        index,
        len: String(message.content ?? "").length,
      }))
      .sort((a, b) => b.len - a.len);
    for (const { index } of prefixByLen) {
      if (estimateMessagesTokens(candidate) <= messageBudget) break;
      const content = String(prefix[index].content ?? "");
      if (content.length < 200) continue;
      prefix[index] = {
        ...prefix[index],
        content: truncateString(content, Math.floor(content.length * 0.5)),
      };
      candidate = [system, ...prefix, ...suffix];
    }
  }

  // Phase D — system prompt tail (last resort)
  if (estimateMessagesTokens(candidate) > messageBudget) {
    const systemContent = String(system.content ?? "");
    if (systemContent.length > 500) {
      system.content = truncateString(systemContent, Math.floor(systemContent.length * 0.75));
      stats.truncatedSystem = true;
      candidate = [system, ...prefix, ...suffix];
    }
  }

  stats.estAfter = estimateMessagesTokens(candidate);

  if (logger && stats.estAfter < stats.estBefore) {
    logger.warn(
      `[tool-call] context-trim round=${round} estBefore=${stats.estBefore} estAfter=${stats.estAfter} ` +
        `budget=${messageBudget} droppedPrefix=${stats.droppedPrefixMessages} ` +
        `truncatedTools=${stats.truncatedToolMessages} truncatedSystem=${stats.truncatedSystem}`
    );
  } else if (logger && stats.estAfter > messageBudget) {
    logger.warn(
      `[tool-call] context-trim round=${round} still above budget: estAfter=${stats.estAfter} budget=${messageBudget}`
    );
  }

  return { messages: candidate, stats };
}
