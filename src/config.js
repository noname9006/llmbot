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
  llama: {
    // VPS llama-server — always on, always available (Model 1 / fallback)
    vpsUrl: optional("VPS_LLAMA_URL", "http://localhost:8080/v1"),
    vpsModelFile: optional("VPS_MODEL_FILE", "phi4-mini.Q4_K_M.gguf"),

    // Local llama-server — via Tailscale, managed by the local agent
    localLlamaUrl: optional("LOCAL_LLAMA_URL", ""),

    // Windows local agent — manages llama-server process
    agentUrl: optional("LOCAL_AGENT_URL", ""),
    agentToken: optional("LOCAL_AGENT_TOKEN", ""),

    // Local model filenames (passed to agent to load into llama-server)
    localModelCommonFile: optional("LOCAL_MODEL_COMMON_FILE", ""),
    localModelHeavyFile: optional("LOCAL_MODEL_HEAVY_FILE", ""),

    // Inference parameters
    temperature: parseFloat(optional("LLM_TEMPERATURE", "0.8")),
    topP: parseFloat(optional("LLM_TOP_P", "0.95")),
    topK: parseInt(optional("LLM_TOP_K", "40"), 10),
    minP: parseFloat(optional("LLM_MIN_P", "0.0")),
    repeatPenalty: parseFloat(optional("LLM_REPETITION_PENALTY", "1.1")),
    maxTokens: parseInt(optional("LLM_MAX_TOKENS", "2048"), 10),
    // Timeout for a single LLM fetch request in ms (0 = no timeout)
    fetchTimeoutMs: parseInt(optional("LLM_FETCH_TIMEOUT_MS", "120000"), 10),
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
  rateLimit: {
    // Per-user: max N requests per window
    maxRequests: parseInt(optional("RATE_LIMIT_MAX_REQUESTS", "5"), 10),
    windowMs: parseInt(optional("RATE_LIMIT_WINDOW_MS", "30000"), 10),
    // Global: max simultaneous LLM calls in flight
    maxConcurrent: parseInt(optional("MAX_CONCURRENT_REQUESTS", "5"), 10),
  },
  retry: {
    maxAttempts: parseInt(optional("RETRY_MAX_ATTEMPTS", "3"), 10),
    initialDelayMs: parseInt(optional("RETRY_INITIAL_DELAY_MS", "500"), 10),
  },
  health: {
    // Set to a port number to expose a /health HTTP endpoint. 0 = disabled.
    port: parseInt(optional("HEALTH_PORT", "0"), 10),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
