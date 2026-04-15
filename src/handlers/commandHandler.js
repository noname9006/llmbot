import { historyService } from "../services/historyService.js";
import {
  isLocalAvailable,
  isVpsAvailable,
  agentOfflineDurationMs,
  agentOnlineDurationMs,
} from "../services/localAvailabilityService.js";
import { getActiveLocalModel } from "../services/agentService.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

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
 *
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client} _client
 * @param {object} handlers  - injected to break the circular dependency with messageHandler
 * @param {Function} handlers.handleForcedSearch
 * @param {Function} handlers.getSemaphoreStats
 * @returns {Promise<string|null>}
 */
export async function handleCommand(message, _client, handlers = {}) {
  const { handleForcedSearch, handleForcedEscalation, getSemaphoreStats } = handlers;
  const parts = message.content.trim().slice(1).split(/\s+/);
  const cmd = parts[0];

  // Check for dynamic escalation command
  const escalateCmd = config.escalate.command.replace(/^!/, "").toLowerCase();
  if (cmd.toLowerCase() === escalateCmd) {
    if (config.escalate.enabled !== "on" || config.escalate.mode !== "command") {
      return "⚠️ Manual escalation is not enabled.";
    }
    if (!handleForcedEscalation) {
      return "⚠️ Escalation handler is not available.";
    }
    handleForcedEscalation(message).catch((err) => {
      logger.error("Unhandled error in escalation command:", err);
      message.reply("⚠️ An unexpected error occurred during escalation.").catch(() => {});
    });
    return null;
  }

  switch (cmd.toLowerCase()) {
    case "reset": {
      historyService.reset(message.author.id);
      logger.info(`History reset for user ${message.author.tag}`);
      return "🗑️ Your conversation history has been cleared. Fresh start!";
    }

    case "status": {
      // Restrict to guild administrators to avoid leaking operational details
      if (!message.guild || !message.member?.permissions.has("Administrator")) {
        return "⛔ This command is only available to server administrators.";
      }

      const localOnline = isLocalAvailable();
      const vpsOnline = isVpsAvailable();
      const activeModel = getActiveLocalModel();
      const historyCount = historyService.size;
      const { running, queued } = getSemaphoreStats();

      const modelLine = localOnline
        ? `🟢 Local agent **online** (active model: **${activeModel ?? "none"}**)`
        : `🔴 Local agent **offline** — using VPS fallback model`;

      const durationMs = localOnline
        ? agentOnlineDurationMs()
        : agentOfflineDurationMs();
      const durationLine =
        durationMs > 0
          ? `   ⏱ ${localOnline ? "Online" : "Offline"} for **${formatDuration(durationMs)}**`
          : "";

      const vpsLine = vpsOnline
        ? "🟢 VPS llama-server **online**"
        : "🔴 VPS llama-server **offline** ⚠️";

      const concurrencyLine = `⚙️ LLM requests: **${running}** active, **${queued}** queued`;

      return [
        modelLine,
        durationLine,
        vpsLine,
        concurrencyLine,
        `📊 Active user histories: **${historyCount}**`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "search": {
      const query = parts.slice(1).join(" ").trim();
      if (!query) {
        return "Usage: `!search <query>`";
      }
      if (!handleForcedSearch) {
        return "⚠️ Search handler is not available.";
      }
      // handleForcedSearch sends its own replies
      handleForcedSearch(message, query).catch((err) => {
        logger.error("Unhandled error in !search:", err);
        message.reply("⚠️ An unexpected error occurred during the search.").catch(() => {});
      });
      return null;
    }

    case "help": {
      const lines = [
        "**Available commands:**",
        "`!reset` — Clear your conversation history",
        "`!status` — Check local agent availability and active model (admins only)",
        "`!search <query>` — Force a web search via SearXNG",
        "`!help` — Show this message",
        "",
        "**Chatting:** Mention me (`@BotName your question`) to start a conversation.",
      ];
      if (config.escalate.enabled === "on" && config.escalate.mode === "command") {
        lines.splice(3, 0, `\`${config.escalate.command}\` — Escalate to the heavy model`);
      }
      return lines.join("\n");
    }

    default:
      return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a duration in ms as a human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
