import { historyService } from "../services/historyService.js";
import { isLocalAvailable } from "../services/localAvailabilityService.js";
import { getActiveLocalModel } from "../services/agentService.js";
import { handleForcedSearch } from "./messageHandler.js";
import { logger } from "../logger.js";

/**
 * Returns true if the message is a bot command (starts with !).
 * @param {string} content
 */
export function isCommand(content) {
  return content.trim().startsWith("!");
}

/**
 * Dispatches a command message and returns a reply string, or null if unknown.
 * For the !search command, sends its own replies and returns null.
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client} _client
 * @returns {Promise<string|null>}
 */
export async function handleCommand(message, _client) {
  const parts = message.content.trim().slice(1).split(/\s+/);
  const cmd = parts[0];

  switch (cmd.toLowerCase()) {
    case "reset": {
      historyService.reset(message.author.id);
      logger.info(`History reset for user ${message.author.tag}`);
      return "🗑️ Your conversation history has been cleared. Fresh start!";
    }

    case "status": {
      const localOnline = isLocalAvailable();
      const activeModel = getActiveLocalModel();
      const historyCount = historyService.size;

      const modelLine = localOnline
        ? `🟢 Local agent **online** (active model: **${activeModel ?? "none"}**)`
        : `🔴 Local agent **offline** — using VPS fallback model`;

      return [
        modelLine,
        `📊 Active user histories: **${historyCount}**`,
      ].join("\n");
    }

    case "search": {
      const query = parts.slice(1).join(" ").trim();
      if (!query) {
        return "Usage: `!search <query>`";
      }
      // handleForcedSearch sends its own replies
      handleForcedSearch(message, query).catch((err) => {
        logger.error("Unhandled error in !search:", err);
        message.reply("⚠️ An unexpected error occurred during the search.").catch(() => {});
      });
      return null;
    }

    case "help": {
      return [
        "**Available commands:**",
        "`!reset` — Clear your conversation history",
        "`!status` — Check local agent availability and active model",
        "`!search <query>` — Force a web search via SearXNG",
        "`!help` — Show this message",
        "",
        "**Chatting:** Mention me (`@BotName your question`) to start a conversation.",
      ].join("\n");
    }

    default:
      return null;
  }
}
