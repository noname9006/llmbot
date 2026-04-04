import { config } from "./config.js";
import { logger } from "./logger.js";
import { createBot } from "./bot.js";
import { getSemaphoreStats } from "./handlers/messageHandler.js";
import { clearHeavyIdleTimer } from "./services/agentService.js";

logger.info("Starting discord-llm-bot...");
logger.info(`VPS llama-server: ${config.llama.vpsUrl} (model: ${config.llama.vpsModelFile})`);
logger.info(`Local agent: ${config.llama.agentUrl || "(not configured)"}`);
logger.info(`Local llama-server: ${config.llama.localLlamaUrl || "(not configured)"}`);
logger.info(`  Common model: ${config.llama.localModelCommonFile || "(not configured)"}`);
logger.info(`  Heavy model:  ${config.llama.localModelHeavyFile || "(not configured)"}`);

const client = createBot();

// Login
client.login(config.discord.token).catch((err) => {
  logger.error("Failed to log in to Discord:", err);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal} — stopping new messages and waiting for in-flight requests…`);

  // Stop accepting new messages immediately
  client.removeAllListeners("messageCreate");

  // Wait up to 30 s for all in-flight LLM calls to complete
  const deadline = Date.now() + 30_000;
  while (getSemaphoreStats().running > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const { running } = getSemaphoreStats();
  if (running > 0) {
    logger.warn(`Shutdown: ${running} request(s) still in flight after timeout — proceeding anyway`);
  }

  // Cancel the heavy-model idle timer so it cannot fire an agentStop() call
  // after the process has started tearing down.
  clearHeavyIdleTimer();

  logger.info("Shutdown complete — disconnecting from Discord");
  client.destroy();
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
