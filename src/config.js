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
  ollama: {
    vpsBaseUrl: optional("VPS_OLLAMA_BASE_URL", "http://localhost:11434"),
    localBaseUrl: required("LOCAL_OLLAMA_BASE_URL"),
    vpsModel: optional("VPS_MODEL", "phi4-mini"),
    localModelCommon: required("LOCAL_MODEL_COMMON"),
    localModelHeavy: required("LOCAL_MODEL_HEAVY"),
    temperature: parseFloat(optional("LLM_TEMPERATURE", "0.8")),
    topP: parseFloat(optional("LLM_TOP_P", "0.95")),
    topK: parseInt(optional("LLM_TOP_K", "40"), 10),
    minP: parseFloat(optional("LLM_MIN_P", "0.0")),
    repeatPenalty: parseFloat(optional("LLM_REPETITION_PENALTY", "1.1")),
    maxTokens: parseInt(optional("LLM_MAX_TOKENS", "2048"), 10),
  },
  llm: {
    systemPrompt: loadSystemPrompt(),
  },
  availability: {
    pollIntervalMs: parseInt(
      optional("LOCAL_HEALTH_POLL_INTERVAL_MS", "30000"),
      10
    ),
  },
  search: {
    searxngBaseUrl: optional("SEARXNG_BASE_URL", ""),
    resultCount: parseInt(optional("SEARCH_RESULT_COUNT", "5"), 10),
  },
  history: {
    maxPairs: parseInt(optional("HISTORY_MAX_PAIRS", "10"), 10),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
