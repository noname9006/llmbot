import { config } from "./config.js";
import { logger } from "./logger.js";
import { createBot } from "./bot.js";

logger.info("Starting discord-llm-bot...");
logger.info(`VPS Ollama: ${config.ollama.vpsBaseUrl} (model: ${config.ollama.vpsModel})`);
logger.info(`Local Ollama: ${config.ollama.localBaseUrl}`);
logger.info(`  Common model: ${config.ollama.localModelCommon}`);
logger.info(`  Heavy model:  ${config.ollama.localModelHeavy}`);

const client = createBot();

// Login
client.login(config.discord.token).catch((err) => {
  logger.error("Failed to log in to Discord:", err);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});
