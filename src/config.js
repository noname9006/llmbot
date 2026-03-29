import "dotenv/config";

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key, fallback) {
  return process.env[key] ?? fallback;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    allowedChannelIds: optional("ALLOWED_CHANNEL_IDS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  llm: {
    baseUrl: optional("LLM_BASE_URL", "http://127.0.0.1:7860/v1"),
    model: optional("LLM_MODEL", "qwen3.5-prism-dynamic-quant"),
    systemPrompt: optional(
      "SYSTEM_PROMPT",
      "You are a helpful, concise assistant inside a Discord server."
    ),
    maxTokens: parseInt(optional("LLM_MAX_TOKENS", "1024"), 10),
    temperature: parseFloat(optional("LLM_TEMPERATURE", "0.7")),
  },
  history: {
    maxPairs: parseInt(optional("HISTORY_MAX_PAIRS", "10"), 10),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
