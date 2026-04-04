import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import http from "http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { onMessage } from "./handlers/messageHandler.js";
import { startPolling, isLocalAvailable, isVpsAvailable } from "./services/localAvailabilityService.js";
import { getActiveLocalModel } from "./services/agentService.js";
import { getSemaphoreStats } from "./handlers/messageHandler.js";

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

    // Start polling local agent and VPS availability (immediate + interval)
    startPolling();

    // Start optional HTTP health server
    startHealthServer(c);
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

// ── Health server ─────────────────────────────────────────────────────────────

/**
 * Starts a minimal HTTP server exposing GET /health for external monitors.
 * Only started if HEALTH_PORT is set to a non-zero value.
 *
 * @param {import("discord.js").Client} discordClient
 */
function startHealthServer(discordClient) {
  const port = config.health.port;
  if (!port) return;

  const server = http.createServer((req, res) => {
    // Only serve GET /health — reject everything else to minimise attack surface
    const url = new URL(req.url ?? "/", `http://localhost`);
    if (req.method !== "GET" || url.pathname !== "/health") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Optional bearer token protection
    if (config.health.token) {
      const auth = req.headers["authorization"] ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== config.health.token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const { running, queued } = getSemaphoreStats();
    const payload = {
      status: "ok",
      discord: discordClient.isReady() ? "ready" : "not_ready",
      localAgent: isLocalAvailable() ? "online" : "offline",
      activeModel: getActiveLocalModel(),
      vps: isVpsAvailable() ? "online" : "offline",
      llmRequests: { running, queued },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  server.listen(port, () => {
    logger.info(`Health server listening on port ${port}`);
  });

  server.on("error", (err) => {
    logger.error("Health server error:", err);
  });
}
