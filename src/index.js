import { config } from "./config.js";
import { logger } from "./logger.js";
import { remoteClient, localClient } from "./bot.js";
import { getSemaphoreStats } from "./handlers/messageHandler.js";
import { clearLocalIdleTimer } from "./services/agentService.js";
import { stopVpsLlamaServer } from "./services/vpsLlamaProcess.js";
import { initRemoteBackend, stopOrRemoteMonitor } from "./services/remoteAvailabilityService.js";
import { initMcp, shutdownMcp } from "./services/mcpService.js";

// Deprecation warning for legacy DISCORD_TOKEN env var
if (process.env._DISCORD_TOKEN_DEPRECATED === "1") {
  logger.warn(
    "DEPRECATED: DISCORD_TOKEN is set but DISCORD_TOKEN_REMOTE is not. " +
    "Please rename DISCORD_TOKEN to DISCORD_TOKEN_REMOTE in your .env file."
  );
}

logger.info("Starting discord-llm-bot (dual-model architecture)…");
logger.info(`Remote model: ${config.llama.remoteUrl} (model: ${config.llama.remoteModelFile})`);
logger.info(`Local agent:  ${config.llama.agentUrl  || "(not configured)"}`);
logger.info(`Local model:  ${config.llama.localUrl  || "(not configured)"}`);
logger.info(`  Local model file: ${config.llama.localModelFile || "(not configured)"}`);
logger.info(`Local bot:    ${config.discord.tokenLocal ? "configured" : "disabled (DISCORD_TOKEN_LOCAL not set)"}`);

// OpenRouter alternative backend (per role). Active only when the role flag is
// set AND an API key is configured.
const _orKey = Boolean(config.openrouter.apiKey);
const _orSummary = (role) => {
  const r = config.openrouter[role];
  return r.enabled && _orKey ? `on (${r.priority}-first, ${r.model})` : "off";
};
logger.info(`OpenRouter:   remote=${_orSummary("remote")} | local=${_orSummary("local")}`);

// ── Effective runtime config summary ─────────────────────────────────────────
const searchStatus = config.search.enabled === "off"
  ? "disabled"
  : `enabled (mode: ${config.search.mode}, cmd: ${config.search.command})`;
logger.info(`Search: ${searchStatus}`);
logger.info(`MCP: ${config.mcp.enabled ? "enabled" : "disabled"} (configured servers: ${config.mcp.servers.length})`);

logger.debug(`Log level: ${config.logLevel}`);
logger.debug(`Rate limit: ${config.rateLimit.maxRequests} req / ${config.rateLimit.windowMs} ms window, max concurrent: ${config.rateLimit.maxConcurrent}`);
logger.debug(`History: max ${config.history.maxPairs} pairs`);
logger.debug(`Complexity: prompt length threshold=${config.complexity.promptLength}`);

// Initialize remote backend — starts VPS llama-server immediately unless
// OPENROUTER_REMOTE_PRIORITY=openrouter, in which case OR is checked first and
// VPS only starts if OR is unreachable. A periodic monitor keeps the two in sync.
try {
  await initRemoteBackend();
} catch (err) {
  logger.error("Failed to initialize remote backend:", err);
  process.exit(1);
}
await initMcp();

// Login — remote bot is required; local bot is optional
remoteClient.login(config.discord.tokenRemote).catch((err) => {
  logger.error("Failed to log in remote bot to Discord:", err);
  process.exit(1);
});

if (localClient) {
  localClient.login(config.discord.tokenLocal).catch((err) => {
    logger.error("Failed to log in local bot to Discord:", err);
    // Non-fatal: app continues without the local bot
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal} — stopping new messages and waiting for in-flight requests…`);

  // Stop accepting new messages immediately
  remoteClient.removeAllListeners("messageCreate");
  if (localClient) localClient.removeAllListeners("messageCreate");

  // Wait up to 30 s for all in-flight LLM calls to complete
  const deadline = Date.now() + 30_000;
  while (getSemaphoreStats().running > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const { running } = getSemaphoreStats();
  if (running > 0) {
    logger.warn(`Shutdown: ${running} request(s) still in flight after timeout — proceeding anyway`);
  }

  // Cancel the local model idle timer so it cannot fire an agentStop() call
  // after the process has started tearing down.
  clearLocalIdleTimer();

  stopOrRemoteMonitor();
  await stopVpsLlamaServer();
  await shutdownMcp();

  logger.info("Shutdown complete — disconnecting from Discord");
  remoteClient.destroy();
  if (localClient) localClient.destroy();
  process.exit(0);
}

process.on("SIGINT", () => { shutdown("SIGINT").catch((err) => { logger.error("Shutdown error:", err); process.exit(1); }); });
process.on("SIGTERM", () => { shutdown("SIGTERM").catch((err) => { logger.error("Shutdown error:", err); process.exit(1); }); });

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});
