import { randomUUID } from "crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { historyService } from "../services/historyService.js";
import { llamaChat } from "../services/llamaService.js";
import { isLocalAvailable } from "../services/localAvailabilityService.js";
import {
  getActiveLocalModel,
  switchToCommon,
  switchToHeavy,
  resetHeavyIdleTimer,
} from "../services/agentService.js";
import { search } from "../services/searchService.js";
import { isCommand, handleCommand } from "./commandHandler.js";
import { createRateLimiter, createSemaphore } from "../utils/rateLimiter.js";

// Leave headroom for edits — Discord's hard limit is 2000 chars
const STREAM_CHUNK_LIMIT = 1900;

// Regex to detect search signal from any model.
// Uses [^\n]+ (not .+ with /s) so only the first line is captured as the
// query — prevents multi-line model output from polluting the search term.
const SEARCH_SIGNAL_RE = /^__SEARCH__:\s*([^\n]+)/;

// Regex to detect escalation signal — matches the signal even when the model
// appends trailing commentary (e.g. "__ESCALATE__ because this is complex").
const ESCALATE_SIGNAL_RE = /^__ESCALATE__/;

// User-facing fallback messages for unexpected model signal outputs.
const MSG_VPS_ESCALATE_FALLBACK =
  "Sorry, I'm having trouble answering this right now. Please try again later.";
const MSG_HEAVY_ESCALATE_FALLBACK =
  "Sorry, I'm having trouble answering this right now. Please try again later.";
const MSG_SEARCH_EMPTY_QUERY =
  "I wanted to search for something but couldn't determine a valid query.";
const MSG_SEARCH_RECURSION =
  "I tried to look that up but wasn't able to find a satisfactory result.";

// Per-user rate limiter
const rateLimiter = createRateLimiter({
  maxRequests: config.rateLimit.maxRequests,
  windowMs: config.rateLimit.windowMs,
});

/**
 * Returns the number of whole seconds a user must wait before their next
 * request is allowed.  Always ≥ 1 so the display never shows "wait 0s".
 * Only call this after rateLimiter.check() returned false.
 * @param {string} userId
 * @returns {number}
 */
function rateLimitRetrySec(userId) {
  return Math.max(1, Math.ceil(rateLimiter.retryAfterMs(userId) / 1000));
}

// Global concurrency semaphore — caps simultaneous LLM calls
const semaphore = createSemaphore(config.rateLimit.maxConcurrent);

// Periodic cleanup — prevent unbounded Map growth in long-running deployments
// (runs once per hour; harmless if the process is restarted frequently)
setInterval(() => {
  rateLimiter.cleanup();
  historyService.cleanup();
}, 60 * 60_000).unref();

/**
 * Called for every incoming message.
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client} client
 */
export async function onMessage(message, client) {
  // Ignore bots (including self)
  if (message.author.bot) return;

  // Channel allowlist check
  if (
    config.discord.allowedChannelIds.length > 0 &&
    !config.discord.allowedChannelIds.includes(message.channelId)
  ) {
    return;
  }

  // ── Commands (no mention required) ─────────────────────────────────────────
  if (isCommand(message.content)) {
    const reply = await handleCommand(message, client, {
      handleForcedSearch,
      getSemaphoreStats,
    });
    if (reply) {
      await message.reply(reply);
    }
    return;
  }

  // ── Must mention the bot to trigger a chat response ────────────────────────
  const isMentioned = message.mentions.has(client.user.id);
  if (!isMentioned) return;

  // Strip the mention(s) from the message text
  const userText = message.content
    .replace(/<@!?\d+>/g, "")
    .trim();

  if (!userText) {
    await message.reply("Hey! Ask me something 😊");
    return;
  }

  // ── Per-user rate limit ─────────────────────────────────────────────────────
  if (!rateLimiter.check(message.author.id)) {
    const retryAfterSec = rateLimitRetrySec(message.author.id);
    await message.reply(
      `⏳ You're sending messages too fast. Please wait ${retryAfterSec}s before trying again.`
    ).catch(() => {});
    return;
  }

  // Assign a correlation ID for tracing this request through all log lines
  const reqId = randomUUID().slice(0, 8);

  logger.info(
    `[${reqId}] [${message.author.tag}] in #${message.channel.name ?? message.channelId}: ${userText.slice(0, 80)}`
  );

  // ── If Model 3 is loaded, reset its idle timer on every new message ────────
  if (getActiveLocalModel() === "heavy") {
    resetHeavyIdleTimer();
  }

  // ── Typing indicator ────────────────────────────────────────────────────────
  await message.channel.sendTyping();
  const typingInterval = setInterval(
    () => message.channel.sendTyping().catch(() => {}),
    8_000
  );

  // ── Acquire global concurrency slot ────────────────────────────────────────
  await semaphore.acquire();

  try {
    // ── Build message history (inside semaphore to avoid dirty-history races) ─
    historyService.pushUser(message.author.id, userText);
    const messages = historyService.getMessages(message.author.id);

    // ── Inject ephemeral capitalization reminder ──────────────────────────────
    const capReminder = buildCapReminder(userText);
    const messagesWithReminder = capReminder
      ? [...messages, { role: "user", content: capReminder }]
      : messages;

    const done = logger.timer(`[${reqId}] full response`, "info");
    const fullResponse = await routeAndRespond(
      reqId,
      message,
      messagesWithReminder,
      userText
    );
    done();

    // Persist the assistant's reply to history (the final user-facing response)
    historyService.pushAssistant(message.author.id, fullResponse);
  } catch (err) {
    logger.error(`[${reqId}] Error during LLM completion:`, err);

    const errorText =
      "⚠️ Something went wrong while contacting the LLM backend. " +
      "Make sure llama-server is running and accessible.";

    await message.reply(errorText).catch(() => {});

    // Roll back only the user message we pushed — leave prior history intact
    historyService.popLastUser(message.author.id);
  } finally {
    semaphore.release();
    clearInterval(typingInterval);
  }
}

// ── Core routing logic ────────────────────────────────────────────────────────

/**
 * Determines which model to use, handles escalation and search signals,
 * posts replies to Discord, and returns the final response text.
 *
 * @param {string} reqId
 * @param {import("discord.js").Message} message
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} userText  - original user text (for search forced commands)
 * @returns {Promise<string>}  the final assistant response that was shown to the user
 */
async function routeAndRespond(reqId, message, messages, userText) {
  if (!isLocalAvailable()) {
    // ── Route 1: local offline → use VPS Model 1 ───────────────────────────
    logger.info(`[${reqId}] Local agent offline — using VPS model (Model 1)`);
    const response = await llamaChat(config.llama.vpsUrl, messages);
    // VPS model should never emit __ESCALATE__; if it does, replace with a
    // safe fallback rather than leaking the raw signal string to the user.
    if (ESCALATE_SIGNAL_RE.test(response.trim())) {
      logger.warn(`[${reqId}] VPS model emitted __ESCALATE__ — replacing with fallback`);
      await sendChunked(message, MSG_VPS_ESCALATE_FALLBACK);
      return MSG_VPS_ESCALATE_FALLBACK;
    }
    const finalResponse = await handleSearchSignal(
      reqId,
      message,
      messages,
      response,
      config.llama.vpsUrl
    );
    await sendChunked(message, finalResponse);
    return finalResponse;
  }

  // ── Route 2: local online → use Model 2 (common) ─────────────────────────
  await switchToCommon();

  logger.info(`[${reqId}] Local agent online — using Model 2 (common)`);
  const model2Response = await llamaChat(config.llama.localLlamaUrl, messages);

  const trimmed = model2Response.trim();

  if (ESCALATE_SIGNAL_RE.test(trimmed)) {
    // ── Route 3: escalation → Model 3 ────────────────────────────────────
    return await handleEscalation(reqId, message, messages);
  }

  const searchMatch = SEARCH_SIGNAL_RE.exec(trimmed);
  if (searchMatch) {
    // ── Route 4: search signal from Model 2 ──────────────────────────────
    const finalResponse = await handleSearchSignal(
      reqId,
      message,
      messages,
      model2Response,
      config.llama.localLlamaUrl
    );
    await sendChunked(message, finalResponse);
    return finalResponse;
  }

  // Normal Model 2 response
  await sendChunked(message, model2Response);
  return model2Response;
}

// ── Escalation flow ───────────────────────────────────────────────────────────

async function handleEscalation(reqId, message, messages) {
  logger.info(`[${reqId}] Model 2 escalated — switching to Model 3 (heavy)`);

  // 1. Ask Model 2 to generate a "I need more time" transition message BEFORE
  //    switching away from it (Model 2 won't be available after switchToHeavy).
  const transitionMessages = [
    ...messages,
    {
      role: "user", +
        "Generate a short, natural, conversational message (1-2 sentences) " +
        "telling the user you need more time to think about this specific question. " +
        "Reference what they asked. Sound human, match their capitalization style. " +
        "Do not mention \"model\" or \"AI\". " +
        "Just say you need to dig deeper, research it, think it through, etc.",
    },
  ];

  const transitionMsg = await llamaChat(
    config.llama.localLlamaUrl,
    transitionMessages
  );

  // 2. Switch to Model 3 BEFORE posting the transition message.
  //    If this fails it throws, the caller's catch block handles cleanup, and
  //    the user never sees a "thinking…" message that leads nowhere.
  await switchToHeavy();

  // 3. Safe to post transition now that Model 3 is confirmed ready.
  await sendChunked(message, transitionMsg);

  // 4. Run Model 3 with the full conversation history
  const heavyResponse = await llamaChat(config.llama.localLlamaUrl, messages);

  const trimmedHeavy = heavyResponse.trim();

  // Guard: Model 3 should not re-emit __ESCALATE__; replace with fallback
  // rather than leaking the raw signal string to the user.
  if (ESCALATE_SIGNAL_RE.test(trimmedHeavy)) {
    logger.warn(`[${reqId}] Model 3 emitted __ESCALATE__ — replacing with fallback`);
    await sendChunked(message, MSG_HEAVY_ESCALATE_FALLBACK);
    return MSG_HEAVY_ESCALATE_FALLBACK;
  }

  // Handle search signal from Model 3 as well
  const searchMatch = SEARCH_SIGNAL_RE.exec(trimmedHeavy);
  if (searchMatch) {
    const finalResponse = await handleSearchSignal(
      reqId,
      message,
      messages,
      heavyResponse,
      config.llama.localLlamaUrl
    );
    await sendChunked(message, finalResponse);
    return finalResponse;
  }

  // 5. Post Model 3's response
  await sendChunked(message, heavyResponse);
  return heavyResponse;
}

// ── Search flow ───────────────────────────────────────────────────────────────

/**
 * Handles a __SEARCH__: <query> signal.
 * Posts a "looking this up..." message, runs the search, injects results,
 * and returns the final model response (does NOT post it — caller does that).
 *
 * @param {string} reqId
 * @param {import("discord.js").Message} message
 * @param {Array<{role: string, content: string}>} messages  - full history up to this point
 * @param {string} modelResponse  - the raw model response containing the search signal
 * @param {string} baseUrl
 * @returns {Promise<string>}  the final answer after search
 */
async function handleSearchSignal(reqId, message, messages, modelResponse, baseUrl) {
  const match = SEARCH_SIGNAL_RE.exec(modelResponse.trim());
  if (!match) return modelResponse;

  const query = sanitizeSearchQuery(match[1].trim());
  // Guard: empty query after sanitization (e.g. the model emitted "__SEARCH__:  ")
  if (!query) {
    logger.warn(`[${reqId}] Search signal with empty query — skipping search`);
    return MSG_SEARCH_EMPTY_QUERY;
  }
  logger.info(`[${reqId}] Search signal detected: "${query}" (url: ${baseUrl})`);

  // 1. Generate a "I'm searching for X" message using the same endpoint
  const searchAckMessages = [
    ...messages,
    {
      role: "user",
      content:
        `The user asked something and you decided to search for: "${query}". ` +
        "Generate a brief, natural message (1 sentence) telling the user you're looking this up. " +
        "Reference what they asked. Match their capitalization style. " +
        "Do not mention 'model' or 'AI'.",
    },
  ];

  const searchAck = await llamaChat(baseUrl, searchAckMessages);
  await sendChunked(message, searchAck);

  // 2. Run the SearXNG query
  let searchResults;
  try {
    searchResults = await search(query);
  } catch (err) {
    logger.error(`[${reqId}] Search failed:`, err);
    searchResults = `[Search results for "${query}":\nSearch unavailable — ${err.message}]`;
  }

  // 3. Inject search results and re-run the model
  const messagesWithResults = [
    ...messages,
    { role: "user", content: searchResults },

  // Guard against the model returning another search signal — prevents the
  // raw __SEARCH__: string from leaking to the user as its final reply.
  if (SEARCH_SIGNAL_RE.test(finalResponse.trim())) {
    logger.warn(`[${reqId}] Model returned a second search signal — aborting recursion`);
    return MSG_SEARCH_RECURSION;
  }

  return finalResponse;
}

/**
 * Handles a forced !search command flow.
 * Runs search with the given query and asks the appropriate model to answer.
 *
 * @param {import("discord.js").Message} message
 * @param {string} query
 */
export async function handleForcedSearch(message, query) {
  // ── Per-user rate limit (commands bypass the top-level check) ──────────────
  if (!rateLimiter.check(message.author.id)) {
    const retryAfterSec = rateLimitRetrySec(message.author.id);
    await message
      .reply(`⏳ You're sending messages too fast. Please wait ${retryAfterSec}s before trying again.`)
      .catch(() => {});
    return;
  }

  const safeQuery = sanitizeSearchQuery(query);
  if (!safeQuery) {
    await message.reply("⚠️ The search query was empty after sanitization.").catch(() => {});
    return;
  }
  const reqId = randomUUID().slice(0, 8);
  logger.info(`[${reqId}] Forced search: "${safeQuery}"`);

  await message.channel.sendTyping();
  const typingInterval = setInterval(
    () => message.channel.sendTyping().catch(() => {}),
    8_000
  );

  await semaphore.acquire();
  try {
    // Pick the endpoint based on current routing state
    const useLocal = isLocalAvailable();
    const baseUrl = useLocal
      ? config.llama.localLlamaUrl
      : config.llama.vpsUrl;

    if (useLocal) {
      await switchToCommon();
    }

    // Get the current history for this user (no new user message pushed)
    const messages = historyService.getMessages(message.author.id);

    // Post acknowledgement
    const searchAckMessages = [
      ...messages,
      {
        role: "user",
        content:
          `The user issued a !search command for: "${safeQuery}". ` +
          "Generate a brief, natural message (1 sentence) telling the user you're looking this up. " +
          "Match their capitalization style. Do not mention 'model' or 'AI'.",
      },
    ];
    const searchAck = await llamaChat(baseUrl, searchAckMessages);
    await sendChunked(message, searchAck);

    // Run search
    let searchResults;
    try {
      searchResults = await search(safeQuery);
    } catch (err) {
      logger.error(`[${reqId}] Forced search failed:`, err);
      searchResults = `[Search results for "${safeQuery}":\nSearch unavailable — ${err.message}]`;
    }

    // Re-run model with results
    const messagesWithResults = [
      ...messages,
      { role: "user", content: `!search ${safeQuery}` },
      { role: "user", content: searchResults },
    ];

    const finalResponse = await llamaChat(baseUrl, messagesWithResults);
    await sendChunked(message, finalResponse);

    // Persist to history
    historyService.pushUser(message.author.id, `!search ${safeQuery}`);
    historyService.pushAssistant(message.author.id, finalResponse);
  } catch (err) {
    logger.error(`[${reqId}] Error during forced search:`, err);
    await message
      .reply("⚠️ Something went wrong during the search.")
      .catch(() => {});
  } finally {
    semaphore.release();
    clearInterval(typingInterval);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Exposes current semaphore stats for observability (used by !status).
 * @returns {{ running: number, queued: number }}
 */
export function getSemaphoreStats() {
  return { running: semaphore.running, queued: semaphore.queued };
}

/**
 * Sends text as one or more Discord messages, respecting the 2000-char limit.
 * First chunk is a reply; subsequent chunks are plain channel messages.
 * @param {import("discord.js").Message} message
 * @param {string} text
 */
async function sendChunked(message, text) {
  const chunks = splitMessage((text ?? "").trim() || "*(no response)*");
  if (chunks.length === 0) {
    await message.reply("*(no response)*");
    return;
  }
  await message.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await message.channel.send(chunks[i]).catch((err) => {
      logger.warn(`sendChunked: failed to send chunk ${i + 1}/${chunks.length}: ${err.message}`);
    });
  }
}

/**
 * Detects the capitalization style of the first word of `text` and returns
 * an ephemeral system-level reminder string, or `null` if the text is empty.
 * @param {string} text
 * @returns {string|null}
 */
function buildCapReminder(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  if (!firstWord) return null;

  // Extract only the letters from the first word to determine its casing
  const letters = firstWord.replace(/[^A-Za-z]/g, "");
  if (!letters) {
    // First word has no letters at all — fall back to lowercase reminder
    return "[CAPITALIZATION REMINDER: User's message is lowercase. Your response must be entirely lowercase.]";
  }

  if (letters.length > 1 && letters === letters.toUpperCase()) {
    return "[CAPITALIZATION REMINDER: User's message is ALL CAPS. Your ENTIRE response must be ALL CAPS.]";
  }

  if (letters[0] === letters[0].toUpperCase()) {
    return "[CAPITALIZATION REMINDER: User's message starts with uppercase. Your response MUST start with an uppercase letter and use normal sentence capitalization.]";
  }

  return "[CAPITALIZATION REMINDER: User's message is lowercase. Your response must be entirely lowercase.]";
}

/**
 * Sanitizes a search query before embedding it in a system message.
 * Strips characters that could be used for prompt injection, collapses
 * whitespace, and truncates to a safe length.
 * @param {string} query
 * @returns {string}
 */
function sanitizeSearchQuery(query) {
  return query
    .replace(/[\r\n]+/g, " ")   // no newlines — they could break system message structure
    .replace(/[`"]/g, "")       // no backticks or quotes — could escape template strings
    .replace(/\s{2,}/g, " ")    // collapse runs of whitespace
    .slice(0, 200)               // hard length cap
    .trim();
}

/**
 * Splits text into chunks of at most `limit` characters.
 * Prefers splitting on newline boundaries, then word boundaries.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
function splitMessage(text, limit = STREAM_CHUNK_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Try to split on a newline within the limit
    let splitAt = remaining.slice(0, limit).lastIndexOf("\n");

    // Fall back to a word boundary (space) within the limit
    if (splitAt <= 0) {
      splitAt = remaining.slice(0, limit).lastIndexOf(" ");
    }

    // Last resort: hard cut at the limit
    if (splitAt <= 0) {
      splitAt = limit;
    }

    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
