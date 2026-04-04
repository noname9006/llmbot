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

// Leave headroom for edits — Discord's hard limit is 2000 chars
const STREAM_CHUNK_LIMIT = 1900;

// Regex to detect search signal from any model
const SEARCH_SIGNAL_RE = /^__SEARCH__:\s*(.+)$/s;

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
    const reply = await handleCommand(message, client);
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

  logger.info(
    `[${message.author.tag}] in #${message.channel.name ?? message.channelId}: ${userText.slice(0, 80)}`
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

  // ── Build message history ───────────────────────────────────────────────────
  historyService.pushUser(message.author.id, userText);
  const messages = historyService.getMessages(message.author.id);

  // ── Inject ephemeral capitalization reminder ────────────────────────────────
  const capReminder = buildCapReminder(userText);
  const messagesWithReminder = capReminder
    ? [...messages, { role: "system", content: capReminder }]
    : messages;

  try {
    const fullResponse = await routeAndRespond(
      message,
      messagesWithReminder,
      userText
    );

    // Persist the assistant's reply to history (the final user-facing response)
    historyService.pushAssistant(message.author.id, fullResponse);
  } catch (err) {
    logger.error("Error during LLM completion:", err);

    const errorText =
      "⚠️ Something went wrong while contacting the LLM backend. " +
      "Make sure llama-server is running and accessible.";

    await message.reply(errorText).catch(() => {});

    // Roll back only the user message we pushed — leave prior history intact
    historyService.popLastUser(message.author.id);
  } finally {
    clearInterval(typingInterval);
  }
}

// ── Core routing logic ────────────────────────────────────────────────────────

/**
 * Determines which model to use, handles escalation and search signals,
 * posts replies to Discord, and returns the final response text.
 *
 * @param {import("discord.js").Message} message
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} userText  - original user text (for search forced commands)
 * @returns {Promise<string>}  the final assistant response that was shown to the user
 */
async function routeAndRespond(message, messages, userText) {
  if (!isLocalAvailable()) {
    // ── Route 1: local offline → use VPS Model 1 ───────────────────────────
    logger.info("Local agent offline — using VPS model (Model 1)");
    const response = await llamaChat(config.llama.vpsUrl, messages);
    const finalResponse = await handleSearchSignal(
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

  logger.info("Local agent online — using Model 2 (common)");
  const model2Response = await llamaChat(config.llama.localLlamaUrl, messages);

  const trimmed = model2Response.trim();

  if (trimmed === "__ESCALATE__") {
    // ── Route 3: escalation → Model 3 ────────────────────────────────────
    return await handleEscalation(message, messages);
  }

  const searchMatch = SEARCH_SIGNAL_RE.exec(trimmed);
  if (searchMatch) {
    // ── Route 4: search signal from Model 2 ──────────────────────────────
    const finalResponse = await handleSearchSignal(
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

async function handleEscalation(message, messages) {
  logger.info("Model 2 escalated — switching to Model 3 (heavy)");

  // 1. Ask Model 2 to generate a natural "I need more time" transition message
  const transitionMessages = [
    ...messages,
    {
      role: "system",
      content:
        "You are about to hand off this question to a more powerful model. " +
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

  // 2. Post the transition message immediately
  await sendChunked(message, transitionMsg);

  // 3. Switch to Model 3
  await switchToHeavy();

  // 4. Run Model 3 with the full conversation history
  const heavyResponse = await llamaChat(config.llama.localLlamaUrl, messages);

  const trimmedHeavy = heavyResponse.trim();

  // Handle search signal from Model 3 as well
  const searchMatch = SEARCH_SIGNAL_RE.exec(trimmedHeavy);
  if (searchMatch) {
    const finalResponse = await handleSearchSignal(
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
 * @param {import("discord.js").Message} message
 * @param {Array<{role: string, content: string}>} messages  - full history up to this point
 * @param {string} modelResponse  - the raw model response containing the search signal
 * @param {string} baseUrl
 * @returns {Promise<string>}  the final answer after search
 */
async function handleSearchSignal(
  message,
  messages,
  modelResponse,
  baseUrl
) {
  const match = SEARCH_SIGNAL_RE.exec(modelResponse.trim());
  if (!match) return modelResponse;

  const query = match[1].trim();
  logger.info(`Search signal detected: "${query}" (url: ${baseUrl})`);

  // 1. Generate a "I'm searching for X" message using the same endpoint
  const searchAckMessages = [
    ...messages,
    {
      role: "system",
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
    logger.error("Search failed:", err.message);
    searchResults = `[Search results for "${query}":\nSearch unavailable — ${err.message}]`;
  }

  // 3. Inject search results and re-run the model
  const messagesWithResults = [
    ...messages,
    { role: "system", content: searchResults },
  ];

  const finalResponse = await llamaChat(baseUrl, messagesWithResults);
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
  logger.info(`Forced search: "${query}"`);

  await message.channel.sendTyping();
  const typingInterval = setInterval(
    () => message.channel.sendTyping().catch(() => {}),
    8_000
  );

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
        role: "system",
        content:
          `The user issued a !search command for: "${query}". ` +
          "Generate a brief, natural message (1 sentence) telling the user you're looking this up. " +
          "Match their capitalization style. Do not mention 'model' or 'AI'.",
      },
    ];
    const searchAck = await llamaChat(baseUrl, searchAckMessages);
    await sendChunked(message, searchAck);

    // Run search
    let searchResults;
    try {
      searchResults = await search(query);
    } catch (err) {
      logger.error("Forced search failed:", err.message);
      searchResults = `[Search results for "${query}":\nSearch unavailable — ${err.message}]`;
    }

    // Re-run model with results
    const messagesWithResults = [
      ...messages,
      { role: "user", content: `!search ${query}` },
      { role: "system", content: searchResults },
    ];

    const finalResponse = await llamaChat(baseUrl, messagesWithResults);
    await sendChunked(message, finalResponse);

    // Persist to history
    historyService.pushUser(message.author.id, `!search ${query}`);
    historyService.pushAssistant(message.author.id, finalResponse);
  } catch (err) {
    logger.error("Error during forced search:", err);
    await message
      .reply("⚠️ Something went wrong during the search.")
      .catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sends text as one or more Discord messages, respecting the 2000-char limit.
 * First chunk is a reply; subsequent chunks are plain channel messages.
 * @param {import("discord.js").Message} message
 * @param {string} text
 */
async function sendChunked(message, text) {
  const chunks = splitMessage(text || "*(no response)*");
  if (chunks.length === 0) {
    await message.reply("*(no response)*");
    return;
  }
  await message.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await message.channel.send(chunks[i]);
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

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
