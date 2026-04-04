import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { onMessage } from "./handlers/messageHandler.js";
import { startPolling } from "./services/localAvailabilityService.js";

export function createBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  // ── Ready ────────────────────────────────────────────────────────────────────
  client.once("ready", async (c) => {
    logger.info(`✅ Logged in as ${c.user.tag} (${c.user.id})`);

    if (config.discord.allowedChannelIds.length > 0) {
      logger.info(
        `Restricted to channels: ${config.discord.allowedChannelIds.join(", ")}`
      );
    } else {
      logger.info("No channel restriction — responding in all channels.");
    }

    // Start polling local agent availability (immediate + interval)
    startPolling();
  });

  // ── Messages ─────────────────────────────────────────────────────────────────
  client.on("messageCreate", (message) => {
    onMessage(message, client).catch((err) => {
      logger.error("Unhandled error in messageCreate:", err);
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────────
  client.on("error", (err) => {
    logger.error("Discord client error:", err);
  });

  client.on("warn", (info) => {
    logger.warn("Discord client warning:", info);
  });

  return client;
}
