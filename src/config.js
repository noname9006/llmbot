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

function loadSystemPromptForRole(role) {
  try {
    const filePath = new URL(`../sysprompt_${role}.txt`, import.meta.url);
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    // fall back to role-specific env var
  }
  const envKey = `SYSTEM_PROMPT_${role.toUpperCase()}`;
  if (process.env[envKey]) {
    return process.env[envKey];
  }
  return loadSystemPrompt();
}

// ── Pre-computed fallbacks used by per-model config fields ───────────────────

const _extraArgsFallback = optional("LLAMA_EXTRA_ARGS", "");

const _ctxFallback = optional("LLAMA_CONTEXT_SIZE", "0");

const _timeoutFallback = parseInt(optional("LLM_FETCH_TIMEOUT_MS", "120000"), 10);

// Global inference parameter defaults (read once; per-model values fall back here)
const _llamaGlobals = {
  temperature:   parseFloat(optional("LLM_TEMPERATURE",        "0.8")),
  topP:          parseFloat(optional("LLM_TOP_P",              "0.95")),
  topK:          parseInt(  optional("LLM_TOP_K",              "40"),   10),
  minP:          parseFloat(optional("LLM_MIN_P",              "0.0")),
  repeatPenalty: parseFloat(
    optional("LLM_REPEAT_PENALTY", optional("LLM_REPETITION_PENALTY", "1.1"))
  ),
  maxTokens:     parseInt(  optional("LLM_MAX_TOKENS",         "2048"), 10),
};

/**
 * Builds per-model inference params, falling back to the global defaults.
 * Must be called AFTER _llamaGlobals is defined.
 * @param {'VPS'|'COMMON'|'HEAVY'} suffix  - uppercase role suffix
 */
function inferenceParams(suffix) {
  return {
    temperature:   parseFloat(optional(`LLM_TEMPERATURE_${suffix}`,    String(_llamaGlobals.temperature))),
    topP:          parseFloat(optional(`LLM_TOP_P_${suffix}`,          String(_llamaGlobals.topP))),
    topK:          parseInt(  optional(`LLM_TOP_K_${suffix}`,          String(_llamaGlobals.topK)),   10),
    minP:          parseFloat(optional(`LLM_MIN_P_${suffix}`,          String(_llamaGlobals.minP))),
    repeatPenalty: parseFloat(optional(`LLM_REPEAT_PENALTY_${suffix}`, String(_llamaGlobals.repeatPenalty))),
    maxTokens:     parseInt(  optional(`LLM_MAX_TOKENS_${suffix}`,     String(_llamaGlobals.maxTokens)), 10),
  };
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

    // Global inference parameters (used as fallback for per-model params below)
    ..._llamaGlobals,

    // Timeout for a single LLM fetch request in ms (0 = no timeout) — global fallback
    fetchTimeoutMs: _timeoutFallback,

    // ── Per-model llama.cpp extra args (passed to agent /start) ──────────────
    // Falls back to LLAMA_EXTRA_ARGS if the role-specific var is not set.
    extraArgsVps:    optional("LLAMA_EXTRA_ARGS_VPS",    _extraArgsFallback),
    extraArgsCommon: optional("LLAMA_EXTRA_ARGS_COMMON", _extraArgsFallback),
    extraArgsHeavy:  optional("LLAMA_EXTRA_ARGS_HEAVY",  _extraArgsFallback),

    // ── Per-model context size (passed to agent /start) ───────────────────────
    // Falls back to LLAMA_CONTEXT_SIZE if the role-specific var is not set.
    contextSizeVps:    parseInt(optional("LLAMA_CONTEXT_SIZE_VPS",    _ctxFallback), 10) || 0,
    contextSizeCommon: parseInt(optional("LLAMA_CONTEXT_SIZE_COMMON", _ctxFallback), 10) || 0,
    contextSizeHeavy:  parseInt(optional("LLAMA_CONTEXT_SIZE_HEAVY",  _ctxFallback), 10) || 0,

    // ── Per-model fetch timeouts ───────────────────────────────────────────────
    // Falls back to LLM_FETCH_TIMEOUT_MS if the role-specific var is not set.
    fetchTimeoutVps:    parseInt(optional("LLM_FETCH_TIMEOUT_MS_VPS",    String(_timeoutFallback)), 10),
    fetchTimeoutCommon: parseInt(optional("LLM_FETCH_TIMEOUT_MS_COMMON", String(_timeoutFallback)), 10),
    fetchTimeoutHeavy:  parseInt(optional("LLM_FETCH_TIMEOUT_MS_HEAVY",  String(_timeoutFallback)), 10),

    // ── Per-model inference parameters ────────────────────────────────────────
    // Each field falls back to the global value if the role-specific var is unset.
    paramsVps:    inferenceParams("VPS"),
    paramsCommon: inferenceParams("COMMON"),
    paramsHeavy:  inferenceParams("HEAVY"),
  },
  llm: {
    systemPrompt: loadSystemPrompt(),           // kept for backward compat
    systemPromptVps:    loadSystemPromptForRole("vps"),
    systemPromptCommon: loadSystemPromptForRole("common"),
    systemPromptHeavy:  loadSystemPromptForRole("heavy"),
  },
  availability: {
    pollIntervalMs: parseInt(
      optional("LOCAL_HEALTH_POLL_INTERVAL_MS", "30000"),
      10
    ),
  },
  escalate: {
    enabled: optional("ESCALATE",         "on"),       // "on" | "off"
    mode:    optional("ESCALATE_MODE",    "auto"),     // "auto" | "command"
    command: optional("ESCALATE_COMMAND", "!escalate"), // must start with !
    type:    optional("ESCALATE_TYPE",    "model"),    // "model" | "args"
  },
  search: {
    searxngBaseUrl: optional("SEARXNG_BASE_URL", ""),
    resultCount: parseInt(optional("SEARCH_RESULT_COUNT", "5"), 10),
    enabled: optional("SEARCH",         "on"),       // "on" | "off"
    mode:    optional("SEARCH_MODE",    "auto"),     // "auto" | "command"
    command: optional("SEARCH_COMMAND", "!search"),  // must start with !
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
    // Optional bearer token to protect the /health endpoint. Empty = no auth.
    token: optional("HEALTH_TOKEN", ""),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
