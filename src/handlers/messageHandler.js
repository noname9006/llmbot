import { randomUUID } from "crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { historyService } from "../services/historyService.js";
import { llamaChat } from "../services/llamaService.js";
import { isLocalAvailable } from "../services/localAvailabilityService.js";
import { ensureLocalModel } from "../services/agentService.js";
import { search } from "../services/searchService.js";
import { isCommand, handleCommand } from "./commandHandler.js";
import { createRateLimiter, createSemaphore } from "../utils/rateLimiter.js";
import { parseEscalationBlock, buildEscalationInstruction } from "../utils/escalationParser.js";
import {
  setLocalPresenceOnline,
  setLocalPresenceCooldown,
} from "../services/localPresenceService.js";

// ── Per-model llamaChat options ───────────────────────────────────────────────

/**
 * Returns llamaChat opts (API inference params + per-call fetch timeout) for
 * the given model role.  Callers spread this into their llamaChat opts argument
 * so the correct params are sent for every role.
 *
 * @param {'remote'|'local'} role
 * @returns {object}
 */
function modelOpts(role) {
  const capRole = role[0].toUpperCase() + role.slice(1); // "Remote" | "Local"
  const params  = config.llama[`params${capRole}`];
  return {
    temperature:    params.temperature,
    top_p:          params.topP,
    top_k:          params.topK,
    min_p:          params.minP,
    repeat_penalty: params.repeatPenalty,
    max_tokens:     params.maxTokens > 0 ? params.maxTokens : -1,
    ...(params.reasoningBudget >= 0 ? { budget_tokens: params.reasoningBudget } : {}),
    fetchTimeout:   config.llama[`fetchTimeout${capRole}`],
  };
}

// Leave headroom for edits — Discord's hard limit is 2000 chars
const STREAM_CHUNK_LIMIT = 1900;

// Regex to detect search signal from any model.
// Uses [^\n]+ (not .+ with /s) so only the first line is captured as the
// query — prevents multi-line model output from polluting the search term.
const SEARCH_SIGNAL_RE = /^__SEARCH__:\s*([^\n]+)/;

// Regex used to strip leaked signal tokens from model output before sending
// to Discord.  Matches __SEARCH__: <rest of line>.
const SIGNAL_STRIP_RE = /__SEARCH__:[^\n]*/g;

// User-facing fallback messages for unexpected model signal outputs.
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

// ── Remote bot message handler ────────────────────────────────────────────────

/**
 * Called for every incoming message on the remote bot (Bot #1).
 * Handles commands, rate limiting, complexity detection, and routing:
 *   - Simple requests → answered directly by the remote model.
 *   - Complex requests (local bot available) → remote provides a brief
 *     starter answer and tags the local bot (@LocalBot) for the deep dive.
 *   - Complex requests (local bot unavailable) → remote answers fully.
 *
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client} remoteClient
 * @param {import("discord.js").Client | null} localClient
 */
export async function onRemoteMessage(message, remoteClient, localClient) {
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
    logger.debug(`[${message.author.tag}] command detected in: "${message.content.trim().slice(0, 80)}"`);
    const reply = await handleCommand(message, remoteClient, {
      handleForcedSearch,
      getSemaphoreStats,
    });
    if (reply) {
      await message.reply(reply);
    }
    return;
  }

  // ── Must mention the remote bot to trigger a chat response ─────────────────
  const isMentioned = message.mentions.has(remoteClient.user.id);
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
    const messages = historyService.getMessages(message.author.id, config.llm.systemPromptRemote);

    // ── Inject ephemeral capitalization reminder ──────────────────────────────
    const capReminder = buildCapReminder(userText);
    const messagesWithReminder = capReminder
      ? [...messages, { role: "user", content: capReminder }]
      : messages;

    const done = logger.timer(`[${reqId}] full response`, "info");
    let fullResponse;
    try {
      fullResponse = await routeRemoteRequest(
        reqId,
        message,
        messagesWithReminder,
        localClient
      );
    } finally {
      done();
    }

    // Persist to history only when the remote model answered directly.
    // null is returned on the handoff path — the local bot owns that exchange
    // and will push its own assistant turn under the same historyUserId.
    if (fullResponse !== null) {
      historyService.pushAssistant(message.author.id, fullResponse);
    }
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

// ── Local bot message handler ─────────────────────────────────────────────────

/**
 * Called when the local bot (Bot #2) receives a message from the remote bot
 * that tags it.  Resolves the original human user ID via the message reference
 * (Option B history key resolution), runs inference against the local model,
 * and posts the deep-dive reply.
 *
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client} localClient
 * @param {import("discord.js").Client} remoteClient
 */
export async function onLocalMessage(message, localClient, remoteClient) {
  const reqId = randomUUID().slice(0, 8);

  // ── Option B: resolve the original human user's ID ─────────────────────────
  // The message was authored by the remote bot (not the human).  We need the
  // human's ID to load/persist history under the correct key.
  // The remote bot sent its relay message as a Discord *reply* to the original
  // human message, so message.reference.messageId points to it.
  let historyUserId;
  if (message.author.bot && message.reference) {
    try {
      const referenced = await message.channel.messages.fetch(message.reference.messageId);
      historyUserId = referenced.author.id;
      logger.debug(`[${reqId}] resolved historyUserId=${historyUserId} from message reference`);
    } catch (err) {
      // Without the original human's ID we cannot load their history or roll
      // it back on failure — using the bot's own ID would corrupt the store.
      logger.warn(
        `[${reqId}] failed to fetch referenced message for history key — aborting handoff: ${err.message}`
      );
      return;
    }
  } else {
    historyUserId = message.author.id;
  }

  // ── Extract the question text (strip all mention tokens) ────────────────────
  const userText = message.content
    .replace(/<@!?\d+>/g, "")
    .trim();

  if (!userText) {
    logger.debug(`[${reqId}] local bot received empty message after stripping mentions — ignoring`);
    return;
  }

  logger.info(
    `[${reqId}] [local] historyUserId=${historyUserId} in #${message.channel.name ?? message.channelId}: ${userText.slice(0, 80)}`
  );

  // ── Typing indicator ────────────────────────────────────────────────────────
  await message.channel.sendTyping();
  const typingInterval = setInterval(
    () => message.channel.sendTyping().catch(() => {}),
    8_000
  );

  // ── Acquire global concurrency slot ────────────────────────────────────────
  await semaphore.acquire();

  // Set presence to Online immediately — we're starting to process
  setLocalPresenceOnline();

  try {
    // Ensure the local model is loaded
    await ensureLocalModel();

    // ── Build message history keyed by the HUMAN's user ID ────────────────────
    // Note: we do NOT push a new user message here — the original human message
    // was already stored by the remote bot handler under historyUserId.
    // We retrieve the existing history and run inference on it.
    const messages = historyService.getMessages(historyUserId, config.llm.systemPromptLocal);

    const done = logger.timer(`[${reqId}] local full response`, "info");
    logger.debug(`[${reqId}] local model messages: ${messages.length} (${Math.floor((messages.length - 1) / 2)} user/assistant pairs)`);

    const rawResponse = stripThinkBlock(
      await llamaChat(config.llama.localUrl, messages, modelOpts("local"))
    );

    // Handle search signal from local model
    const searchMatch = SEARCH_SIGNAL_RE.exec(rawResponse.trim());
    let finalResponse;
    if (searchMatch) {
      if (config.search.enabled === "off") {
        logger.warn(`[${reqId}] [local] __SEARCH__ signal dropped — SEARCH=off`);
        finalResponse = await retryWithoutSearch(reqId, message, messages, config.llama.localUrl, modelOpts("local"));
      } else if (config.search.mode === "command") {
        logger.warn(`[${reqId}] [local] __SEARCH__ auto-signal dropped — SEARCH_MODE=command`);
        finalResponse = await retryWithoutSearch(reqId, message, messages, config.llama.localUrl, modelOpts("local"));
      } else {
        logger.debug(`[${reqId}] [local] __SEARCH__ detected — mode=auto, searching`);
        finalResponse = await handleSearchSignal(reqId, message, messages, rawResponse, config.llama.localUrl, modelOpts("local"));
      }
    } else {
      finalResponse = rawResponse;
    }

    done();

    await sendChunked(message, finalResponse);

    // Persist the local model's reply under the HUMAN's history key
    historyService.pushAssistant(historyUserId, finalResponse);
  } catch (err) {
    logger.error(`[${reqId}] [local] Error during local LLM completion:`, err);
    // Roll back the orphaned user turn that onRemoteMessage pushed under this key.
    // Without this, history is left with an unanswered user entry that causes
    // consecutive user messages on the next exchange.
    historyService.popLastUser(historyUserId);
    await message.channel.send(
      "⚠️ Local model encountered an error. Please try again later."
    ).catch(() => {});
  } finally {
    semaphore.release();
    clearInterval(typingInterval);
    // Transition presence: Online → Idle (after cooldown)
    setLocalPresenceCooldown();
  }
}

// ── Remote routing logic ──────────────────────────────────────────────────────

/**
 * Routes a remote bot request using LLM self-evaluation.
 *
 * The remote model always answers first.  When the local bot is available,
 * an escalation instruction is injected into the message array asking the
 * model to append a JSON complexity block after its answer.  The block is
 * parsed to determine whether to escalate:
 *
 *   should_escalate=false → return the answer directly (local unavailable → same path)
 *   should_escalate=true  → post the answer as a draft + tag @LocalBot; return null
 *                            so the caller skips historyService.pushAssistant and
 *                            lets onLocalMessage own the history for this exchange.
 *
 * @param {string} reqId
 * @param {import("discord.js").Message} message
 * @param {Array<{role: string, content: string}>} messages
 * @param {import("discord.js").Client | null} localClient
 * @returns {Promise<string|null>}  answer text, or null on the handoff path
 */
async function routeRemoteRequest(reqId, message, messages, localClient) {
  const localAvailable = isLocalAvailable() && localClient?.isReady();

  // Inject escalation instruction into the system message when the local bot
  // can actually handle it.  Appending it to the system message (rather than
  // as an extra user turn) keeps the alternating user/assistant message
  // contract intact and is ignored by models that don't support multi-turn
  // system messages.
  const messagesForModel = localAvailable
    ? [
        { role: "system", content: messages[0].content + "\n\n" + buildEscalationInstruction() },
        ...messages.slice(1),
      ]
    : messages;

  logger.info(`[${reqId}] Using remote model`);
  logger.debug(`[${reqId}] messages for LLM: ${messages.length} (${Math.floor((messages.length - 1) / 2)} user/assistant pairs)`);

  const rawResponse = stripThinkBlock(
    await llamaChat(config.llama.remoteUrl, messagesForModel, modelOpts("remote"))
  );

  // Parse the answer + JSON routing block when the local bot is available
  const { answer, shouldEscalate, score } = localAvailable
    ? parseEscalationBlock(rawResponse)
    : { answer: rawResponse, shouldEscalate: false, score: null };

  if (localAvailable && score !== null) {
    logger.debug(`[${reqId}] LLM routing: score=${score} should_escalate=${shouldEscalate}`);
  }

  // Search signal is checked in the clean answer (JSON block already stripped)
  const searchMatch = SEARCH_SIGNAL_RE.exec(answer.trim());
  if (searchMatch) {
    if (config.search.enabled === "off") {
      logger.warn(`[${reqId}] __SEARCH__ signal dropped — SEARCH=off`);
      return await retryWithoutSearch(reqId, message, messages, config.llama.remoteUrl, modelOpts("remote"));
    }
    if (config.search.mode === "command") {
      logger.warn(`[${reqId}] __SEARCH__ auto-signal dropped — SEARCH_MODE=command`);
      return await retryWithoutSearch(reqId, message, messages, config.llama.remoteUrl, modelOpts("remote"));
    }
    logger.debug(`[${reqId}] __SEARCH__ detected — mode=auto, searching`);
    const finalResponse = await handleSearchSignal(
      reqId, message, messages, answer, config.llama.remoteUrl, modelOpts("remote")
    );
    await sendChunked(message, finalResponse);
    return finalResponse;
  }

  // ── Escalation path: post the draft answer and tag the local bot ──────────
  if (shouldEscalate) {
    // Re-check availability — the local bot may have gone offline while the
    // remote model was running (inference can take tens of seconds).
    if (!(isLocalAvailable() && localClient?.isReady())) {
      logger.info(
        `[${reqId}] LLM wanted to escalate but local bot went offline during inference — answering directly`
      );
      await sendChunked(message, answer);
      return answer;
    }
    logger.info(`[${reqId}] LLM self-routing: escalating to local model (score=${score})`);
    const localMention = `<@${localClient.user.id}>`;
    // Append the cc mention if the model did not already include it
    const handoffText = answer.includes(localMention)
      ? answer
      : `${answer}\n\ncc ${localMention}`;
    await sendChunked(message, handoffText);
    // Return null to signal the caller that history ownership passes to the
    // local bot — onRemoteMessage must NOT call historyService.pushAssistant.
    return null;
  }

  // ── No escalation: remote answer is final ────────────────────────────────
  if (localAvailable) {
    logger.debug(`[${reqId}] LLM self-routing: no escalation needed (score=${score ?? "N/A"})`);
  }
  await sendChunked(message, answer);
  return answer;
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
 * @param {object} [opts]  - llamaChat opts (inference params + fetchTimeout) for this role
 * @returns {Promise<string>}  the final answer after search
 */
async function handleSearchSignal(reqId, message, messages, modelResponse, baseUrl, opts = {}) {
  const match = SEARCH_SIGNAL_RE.exec(modelResponse.trim());
  if (!match) return modelResponse;

  const query = sanitizeSearchQuery(match[1].trim());
  // Guard: empty query after sanitization (e.g. the model emitted "__SEARCH__:  ")
  if (!query) {
    logger.warn(`[${reqId}] Search signal with empty query — skipping search`);
    return MSG_SEARCH_EMPTY_QUERY;
  }
  logger.debug(`[${reqId}] handleSearchSignal: query="${query}" url=${baseUrl}`);
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

  const searchAck = stripThinkBlock(await llamaChat(baseUrl, searchAckMessages, opts));
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
  ];

  const finalResponse = stripThinkBlock(await llamaChat(baseUrl, messagesWithResults, opts));

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
  // Belt-and-suspenders: check at entry point in case called from outside commandHandler
  if (config.search.enabled === "off") {
    await message.reply("⚠️ Search is currently disabled.").catch(() => {});
    return;
  }

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
    // Use remote model (always available for forced search)
    const baseUrl = config.llama.remoteUrl;
    const llmOpts = modelOpts("remote");

    // Get the current history for this user (no new user message pushed)
    const messages = historyService.getMessages(
      message.author.id,
      config.llm.systemPromptRemote
    );

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
    const searchAck = stripThinkBlock(await llamaChat(baseUrl, searchAckMessages, llmOpts));
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

    const finalResponse = stripThinkBlock(await llamaChat(baseUrl, messagesWithResults, llmOpts));
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
 * Re-runs the model asking it to answer directly, without searching.
 * Used when search is disabled (SEARCH=off) or suppressed (SEARCH_MODE=command).
 */
async function retryWithoutSearch(reqId, message, messages, baseUrl, opts = {}) {
  logger.debug(`[${reqId}] retryWithoutSearch — re-running without search context`);
  const retryMessages = [
    ...messages,
    {
      role: "user",
      content: "Please answer directly without searching. Use only what you already know.",
    },
  ];
  const retryResponse = stripThinkBlock(await llamaChat(baseUrl, retryMessages, opts));
  await sendChunked(message, retryResponse);
  return retryResponse;
}

/**
 * Exposes current semaphore stats for observability (used by !status).
 * @returns {{ running: number, queued: number }}
 */
export function getSemaphoreStats() {
  return { running: semaphore.running, queued: semaphore.queued };
}

/**
 * Strips any leaked signal tokens (__ESCALATE__ or __SEARCH__: ...) from
 * text before it reaches Discord.  Acts as a last-resort safety net so raw
 * signal strings are never rendered in chat even if a guard upstream misses.
 * @param {string} text
 * @returns {string}
 */
function stripSignals(text) {
  return text.replace(SIGNAL_STRIP_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Sends text as one or more Discord messages, respecting the 2000-char limit.
 * First chunk is a reply; subsequent chunks are plain channel messages.
 * @param {import("discord.js").Message} message
 * @param {string} text
 */
async function sendChunked(message, text) {
  const cleaned = stripSignals((text ?? "").trim());
  const chunks = splitMessage(cleaned || "*(no response)*");
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
 * an ephemeral system-level reminder string that covers both capitalization
 * rules and the escalation check, or `null` if the text is empty.
 * @param {string} text
 * @returns {string|null}
 */
function buildCapReminder(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  if (!firstWord) return null;

  // Extract only the letters from the first word to determine its casing
  const letters = firstWord.replace(/[^A-Za-z]/g, "");

  let capRule;
  if (!letters) {
    // First word has no letters at all — fall back to lowercase reminder
    capRule = "User's message is lowercase. Your response must be entirely lowercase.";
  } else if (letters.length > 1 && letters === letters.toUpperCase()) {
    capRule = "User's message is ALL CAPS. Your ENTIRE response must be ALL CAPS.";
  } else if (letters[0] === letters[0].toUpperCase()) {
    capRule =
      "User's message starts with uppercase. Your response MUST start with an uppercase letter and use normal sentence capitalization.";
  } else {
    capRule =
      "User's message is lowercase. Your response must be entirely lowercase.";
  }

  return `[SYSTEM REMINDER — Capitalization: ${capRule}]`;
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
 * Strips the Gemma 4 thinking block from a raw LLM response.
 * If the response contains <channel|>, only the content after the
 * LAST occurrence is returned (the visible answer), trimmed of leading
 * whitespace. If the tag is absent the string is returned unchanged (no-op).
 * If the string ends with <channel|> (nothing after it), an empty string
 * is returned — sendChunked already handles that with "*(no response)*".
 * @param {string} text
 * @returns {string}
 */
export function stripThinkBlock(text) {
  const marker = "<channel|>";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return text;
  return text.slice(idx + marker.length);
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
