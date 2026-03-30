import "dotenv/config";
import fs from "fs";

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key, fallback) {
  return process.env[key] ?? fallback;
}

function loadSystemPrompt() {
  try {
    const filePath = new URL("../sysprompt.txt", import.meta.url);
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    // fall back to env var or hardcoded default
  }
  return optional(
    "SYSTEM_PROMPT",
    "You are a helpful, concise assistant inside a Discord server."
  );
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
    systemPrompt: loadSystemPrompt(),
    thinkingMode: optional("LLM_THINKING_MODE", "false") === "true",
    temperature: parseFloat(optional("LLM_TEMPERATURE", "0.7")),
    topP: parseFloat(optional("LLM_TOP_P", "0.95")),
    topK: parseInt(optional("LLM_TOP_K", "20"), 10),
    minP: parseFloat(optional("LLM_MIN_P", "0.0")),
    presencePenalty: parseFloat(optional("LLM_PRESENCE_PENALTY", "1.5")),
    repetitionPenalty: parseFloat(optional("LLM_REPETITION_PENALTY", "1.0")),
    maxTokens: parseInt(optional("LLM_MAX_TOKENS", "1024"), 10),
  },
  history: {
    maxPairs: parseInt(optional("HISTORY_MAX_PAIRS", "10"), 10),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
