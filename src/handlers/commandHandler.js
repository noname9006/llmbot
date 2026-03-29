import { historyService } from "../services/historyService.js";
import { checkHealth } from "../services/llmService.js";
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
 * @param {import("discord.js").Message} message
 * @returns {Promise<string|null>}
 */
export async function handleCommand(message) {
  const [cmd] = message.content.trim().slice(1).split(/\s+/);

  switch (cmd.toLowerCase()) {
    case "reset": {
      historyService.reset(message.author.id);
      logger.info(`History reset for user ${message.author.tag}`);
      return "🗑️ Your conversation history has been cleared. Fresh start!";
    }

    case "status": {
      const healthy = await checkHealth();
      const historyCount = historyService.size;
      if (healthy) {
        return `✅ **LM Studio** is reachable.\n📊 Active user histories: **${historyCount}**`;
      } else {
        return `❌ **LM Studio** is **not reachable**. Check the FRP tunnel and LM Studio server.`;
      }
    }

    case "help": {
      return [
        "**Available commands:**",
        "`!reset` — Clear your conversation history",
        "`!status` — Check if the LLM backend is reachable",
        "`!help` — Show this message",
        "",
        "**Chatting:** Mention me (`@BotName your question`) to start a conversation.",
      ].join("\n");
    }

    default:
      return null;
  }
}
