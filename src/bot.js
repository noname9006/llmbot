import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import http from "http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { onRemoteMessage, onLocalMessage, getSemaphoreStats } from "./handlers/messageHandler.js";
import { startPolling, isLocalAvailable, isVpsAvailable } from "./services/localAvailabilityService.js";
import { getActiveLocalModel } from "./services/agentService.js";
import { setLocalClient, setLocalPresenceIdle, setLocalPresenceDnd } from "./services/localPresenceService.js";
import { warmupLocalModel } from "./services/vpsLlamaProcess.js";

// ── Shared client options ─────────────────────────────────────────────────────

const CLIENT_OPTIONS = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
};

// ── Remote bot (Bot #1) ───────────────────────────────────────────────────────

export const remoteClient = new Client(CLIENT_OPTIONS);

remoteClient.once("ready", async (c) => {
  logger.info(`✅ Remote bot logged in as ${c.user.tag} (${c.user.id})`);

  // Set Online presence — remote bot is always available while the app runs
  c.user.setPresence({ status: "online" });

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

remoteClient.on("messageCreate", (message) => {
  onRemoteMessage(message, remoteClient, localClient).catch((err) => {
    logger.error("Unhandled error in remote messageCreate:", err);
  });
});

remoteClient.on("error", (err) => {
  logger.error("Remote Discord client error:", err);
});

remoteClient.on("warn", (info) => {
  logger.warn("Remote Discord client warning:", info);
});

// ── Local bot (Bot #2) ────────────────────────────────────────────────────────
// Only created when DISCORD_TOKEN_LOCAL is set.  When absent the variable is
// exported as null and all local-bot code paths are guarded accordingly.

export let localClient = null;

if (config.discord.tokenLocal) {
  localClient = new Client(CLIENT_OPTIONS);

  localClient.once("ready", async (c) => {
    logger.info(`✅ Local bot logged in as ${c.user.tag} (${c.user.id})`);

    // Register the client with the presence service
    setLocalClient(c);

    // Initial presence depends on whether the local agent is already reachable.
    // The first poll happens in startPolling() (called from remoteClient ready),
    // so we default to DND here — the poll will flip it to Idle if the agent
    // is up.  If the remote bot ready fires before this one, isLocalAvailable()
    // may already reflect the true state.
    if (isLocalAvailable()) {
      setLocalPresenceIdle();
      // Warm up the local model now that we have a client handle
      warmupLocalModel().catch((err) =>
        logger.warn(`Local model warmup (bot ready) failed (non-fatal): ${err.message}`)
      );
    } else {
      setLocalPresenceDnd();
    }
  });

  // Handle messages that are: from the remote bot AND mention the local bot.
  // This is the "handoff" trigger: remote decided the request is complex and
  // tagged us (@LocalBot) to provide the deeper answer.
  localClient.on("messageCreate", (message) => {
    // Guard: only process messages authored by a bot that mention this client
    if (!message.author.bot) return;
    if (!localClient.user || !message.mentions.has(localClient.user.id)) return;
    // Only accept handoffs from the remote bot specifically
    if (remoteClient.user && message.author.id !== remoteClient.user.id) return;

    onLocalMessage(message, localClient, remoteClient).catch((err) => {
      logger.error("Unhandled error in local messageCreate:", err);
    });
  });

  localClient.on("error", (err) => {
    logger.error("Local Discord client error:", err);
  });

  localClient.on("warn", (info) => {
    logger.warn("Local Discord client warning:", info);
  });
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
      remoteBot: discordClient.isReady() ? "ready" : "not_ready",
      localBot: localClient?.isReady() ? "ready" : (localClient ? "not_ready" : "disabled"),
      localAgent: isLocalAvailable() ? "online" : "offline",
      activeModel: getActiveLocalModel(),
      remoteServer: isVpsAvailable() ? "online" : "offline",
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

