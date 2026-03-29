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

  // ── Send placeholder & stream into it ──────────────────────────────────────
  let replyMessage;
  let accumulated = "";
  let lastEditLength = 0;

  try {
    // Send the initial placeholder so we have a message to edit
    replyMessage = await message.reply("▍"); // blinking cursor effect

    const fullResponse = await streamCompletion(messages, async (chunk) => {
      accumulated += chunk;

      // Only edit Discord message every ~80 chars to avoid rate limits
      const shouldEdit =
        accumulated.length - lastEditLength >= 80 ||
        accumulated.endsWith("\n");

      if (shouldEdit) {
        lastEditLength = accumulated.length;
        const display = truncate(accumulated) + " ▍";
        await replyMessage.edit(display).catch((err) => {
          logger.warn("Failed to edit message during stream:", err.message);
        });
      }
    });

    // Final edit: full content, no cursor
    const finalDisplay = truncate(fullResponse);
    await replyMessage.edit(finalDisplay);

    // Persist the assistant's full reply to history
    historyService.pushAssistant(message.author.id, fullResponse);
  } catch (err) {
    logger.error("Error during LLM completion:", err);

    const errorText =
      "⚠️ Something went wrong while contacting the LLM backend. " +
      "Make sure LM Studio is running and the FRP tunnel is active.";

    if (replyMessage) {
      await replyMessage.edit(errorText).catch(() => {});
    } else {
      await message.reply(errorText).catch(() => {});
    }

    // Roll back only the user message we pushed — leave prior history intact
    historyService.popLastUser(message.author.id);
  } finally {
    clearInterval(typingInterval);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncates text to Discord's limit, appending a notice if cut.
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  if (text.length <= STREAM_CHUNK_LIMIT) return text;
  return (
    text.slice(0, STREAM_CHUNK_LIMIT - 40) +
    "\n…*(response truncated — ask me to continue)*"
  );
}
