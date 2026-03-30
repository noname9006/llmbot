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
    model: optional("LLM_MODEL", "Hermes-3-Llama-3.1-8B-Lorablated.Q4_K_M"),
    systemPrompt: loadSystemPrompt(),
    // thinkingMode is only relevant for Qwen-like models; not used by Hermes 3
    thinkingMode: optional("LLM_THINKING_MODE", "false") === "true",
    temperature: parseFloat(optional("LLM_TEMPERATURE", "0.8")),
    topP: parseFloat(optional("LLM_TOP_P", "0.95")),
    topK: parseInt(optional("LLM_TOP_K", "40"), 10),
    minP: parseFloat(optional("LLM_MIN_P", "0.0")),
    presencePenalty: parseFloat(optional("LLM_PRESENCE_PENALTY", "1.5")),
    repetitionPenalty: parseFloat(optional("LLM_REPETITION_PENALTY", "1.1")),
    maxTokens: parseInt(optional("LLM_MAX_TOKENS", "2048"), 10),
  },
  history: {
    maxPairs: parseInt(optional("HISTORY_MAX_PAIRS", "10"), 10),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
