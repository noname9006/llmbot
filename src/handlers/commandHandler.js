import { historyService } from "../services/historyService.js";
import {
  isLocalAvailable,
  isOrLocalAvailable,
  isVpsAvailable,
  agentOfflineDurationMs,
  agentOnlineDurationMs,
} from "../services/localAvailabilityService.js";
import { getActiveLocalModel } from "../services/agentService.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

/**
 * Returns the set of known command tokens (lowercased, with leading !).
 * @returns {Set<string>}
 */
function getKnownCommands() {
  return new Set([
    config.search.command.toLowerCase(),
    "!reset",
    "!status",
    "!help",
  ]);
}

/**
 * Returns true if the message contains a known command token anywhere.
 * Only tokens that exactly match a known command name trigger this — unknown
 * `!word` tokens (e.g. `!defi`) are ignored so they fall through to chat.
 * @param {string} content
 */
export function isCommand(content) {
  const known = getKnownCommands();
  return content.trim().split(/\s+/).some((token) => known.has(token.toLowerCase()));
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
  const { handleForcedSearch, getSemaphoreStats } = handlers;
  const words = message.content.trim().split(/\s+/);
  const known = getKnownCommands();
  const cmdToken = words.find((w) => known.has(w.toLowerCase()));
  if (!cmdToken) return null;
  const cmd = cmdToken.replace(/^!/, "").toLowerCase();

  logger.debug(`[${message.author.tag}] command dispatched: "${cmd}"`);

  // Check for dynamic search command
  const searchCmd = config.search.command.replace(/^!/, "").toLowerCase();
  if (cmd === searchCmd) {
    if (config.search.enabled === "off") {
      return "⚠️ Search is currently disabled.";
    }
    // Query = all words except the !search token itself and any mention tokens
    const query = words
      .filter((w) => !/<@!?\d+>/.test(w) && w.toLowerCase() !== cmdToken.toLowerCase())
      .join(" ")
      .trim();
    if (!query) {
      return `Usage: \`${config.search.command} <query>\``;
    }
    if (!handleForcedSearch) {
      return "⚠️ Search handler is not available.";
    }
    logger.info(`[${message.author.tag}] search command received: "${query.slice(0, 80)}"`);
    // handleForcedSearch sends its own replies
    handleForcedSearch(message, query).catch((err) => {
      logger.error(`Unhandled error in ${config.search.command}:`, err);
      message.reply("⚠️ An unexpected error occurred during the search.").catch(() => {});
    });
    return null;
  }

  switch (cmd) {
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

      const localOnline = isLocalAvailable();   // true if agent OR OR-local is up
      // agentOnlineDurationMs() returns non-zero iff the agent is currently online
      const agentOnline = agentOnlineDurationMs() > 0;
      const orLocalOnline = isOrLocalAvailable();
      const remoteOnline = isVpsAvailable();
      const activeModel = getActiveLocalModel();
      const historyCount = historyService.size;
      const { running, queued } = getSemaphoreStats();

      // Build a human-readable local status line that correctly reflects which
      // backend(s) are actually available, rather than just "agent online/offline".
      let localLine;
      if (!localOnline) {
        localLine = `🔴 Local role **unavailable** — remote model is the only responder`;
      } else if (agentOnline && orLocalOnline) {
        localLine = `🟢 Local role **online** — agent (model: **${activeModel ?? "none"}**) + OpenRouter`;
      } else if (agentOnline) {
        localLine = `🟢 Local role **online** via agent (model: **${activeModel ?? "none"}**)`;
      } else {
        localLine = `🟡 Local role **online** via OpenRouter (agent offline)`;
      }

      // Duration line is only meaningful when the agent is the active backend.
      const agentDurationMs = agentOnline ? agentOnlineDurationMs() : agentOfflineDurationMs();
      const durationLine = agentOnline && agentDurationMs > 0
        ? `   ⏱ Agent online for **${formatDuration(agentDurationMs)}**`
        : (!agentOnline && agentDurationMs > 0
          ? `   ⏱ Agent offline for **${formatDuration(agentDurationMs)}**`
          : "");

      const remoteLine = remoteOnline
        ? "🟢 Remote llama-server **online**"
        : "🔴 Remote llama-server **offline** ⚠️";

      const concurrencyLine = `⚙️ LLM requests: **${running}** active, **${queued}** queued`;

      return [
        localLine,
        durationLine,
        remoteLine,
        concurrencyLine,
        `📊 Active user histories: **${historyCount}**`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "help": {
      const lines = [
        "**Available commands:**",
        "`!reset` — Clear your conversation history",
        "`!status` — Check local agent availability and active model (admins only)",
      ];
      if (config.search.enabled !== "off") {
        lines.push(`\`${config.search.command} <query>\` — Force a web search via SearXNG`);
      }
      lines.push("`!help` — Show this message");
      lines.push("");
      lines.push("**Chatting:** Mention me (`@BotName your question`) to start a conversation.");
      if (config.discord.tokenLocal) {
        lines.push("A local model (Bot #2) is also available for complex deep-dive questions.");
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

