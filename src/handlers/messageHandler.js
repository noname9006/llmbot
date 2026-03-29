import { config } from "../config.js";
import { logger } from "../logger.js";
import { historyService } from "../services/historyService.js";
import { streamCompletion } from "../services/llmService.js";
import { isCommand, handleCommand } from "./commandHandler.js";

// Leave headroom for edits — Discord's hard limit is 2000 chars
const STREAM_CHUNK_LIMIT = 1900;

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
    const reply = await handleCommand(message);
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

  // ── Typing indicator ────────────────────────────────────────────────────────
  await message.channel.sendTyping();
  // Discord typing expires after ~10s; keep refreshing for long responses
  const typingInterval = setInterval(
    () => message.channel.sendTyping().catch(() => {}),
    8_000
  );

  // ── Build message history ───────────────────────────────────────────────────
  historyService.pushUser(message.author.id, userText);
  const messages = historyService.getMessages(message.author.id);

  // ── Wait for full response, then send ──────────────────────────────────────
  try {
    const fullResponse = await streamCompletion(messages);

    // Split into Discord-sized chunks and send
    const chunks = splitMessage(fullResponse);
    if (chunks.length === 0) {
      await message.reply("*(no response)*");
    } else {
      await message.reply(chunks[0]);
    }
    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send(chunks[i]);
    }

    // Persist the assistant's full reply to history
    historyService.pushAssistant(message.author.id, fullResponse);
  } catch (err) {
    logger.error("Error during LLM completion:", err);

    const errorText =
      "⚠️ Something went wrong while contacting the LLM backend. " +
      "Make sure LM Studio is running and the FRP tunnel is active.";

    await message.reply(errorText).catch(() => {});

    // Roll back only the user message we pushed — leave prior history intact
    historyService.popLastUser(message.author.id);
  } finally {
    clearInterval(typingInterval);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
