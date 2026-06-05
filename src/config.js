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

/**
 * Loads the remote (Bot #1) system prompt.
 * Tries sysprompt_remote.txt first, falls back to sysprompt_vps.txt for
 * backward compatibility.
 */
function loadSystemPromptRemote() {
  try {
    const filePath = new URL("../sysprompt_remote.txt", import.meta.url);
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    // fall back to legacy vps prompt
  }
  return loadSystemPromptForRole("vps");
}

/**
 * Loads the local (Bot #2) system prompt.
 * Tries sysprompt_local.txt first, falls back to sysprompt_common.txt for
 * backward compatibility.
 */
function loadSystemPromptLocal() {
  try {
    const filePath = new URL("../sysprompt_local.txt", import.meta.url);
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    // fall back to legacy common prompt
  }
  return loadSystemPromptForRole("common");
}

/**
 * Strips disabled signal blocks from a raw system prompt based on current
 * runtime config.  Applied once at startup so every LLM call uses a
 * pre-cleaned prompt — the model is never taught signals it cannot use.
 *
 * - Removes the __SEARCH__ block (from "__SEARCH__" through the
 *   "Replace <concise web search query>..." line) when SEARCH=off or
 *   SEARCH_MODE=command.
 * - Removes the __ESCALATE__ block (from "__ESCALATE__" through the
 *   "Do NOT use for:..." line) if present — kept for backward compat with
 *   old sysprompt files that still include the block.
 * - Removes example lines referencing stripped signals.
 * - Removes the "=== SIGNALS ===" header when all signal blocks are stripped.
 * - Collapses runs of 3+ blank lines to 2.
 *
 * @param {string} raw
 * @returns {string}
 */
function buildSystemPrompt(raw) {
  const stripSearch =
    optional("SEARCH", "on") === "off" || optional("SEARCH_MODE", "auto") === "command";

  // __ESCALATE__ is always stripped — it no longer exists in the new architecture.
  // We keep the stripping logic so old sysprompt files (still containing the
  // __ESCALATE__ block) are silently cleaned up on load.
  const stripEscalate = true;

  let text = raw;

  if (stripEscalate) {
    // Remove the __ESCALATE__ signal block (from the signal line through
    // the "Do NOT use for:..." closing line, inclusive).
    text = text.replace(
      /^__ESCALATE__[^\n]*\n(?:[^\n]*\n)*?[^\n]*Do NOT use for:[^\n]*\n?/m,
      ""
    );
    // Remove example lines that reference __ESCALATE__.
    text = text.replace(/^"[^"]*"\s*→\s*__ESCALATE__[^\n]*\n?/gm, "");
  }

  if (stripSearch) {
    // Remove the __SEARCH__ signal block (from the signal line through
    // the "Replace <concise web search query>..." closing line, inclusive).
    text = text.replace(
      /^__SEARCH__[^\n]*\n(?:[^\n]*\n)*?[^\n]*Replace <concise web search query>[^\n]*\n?/m,
      ""
    );
    // Remove example lines that reference __SEARCH__:.
    text = text.replace(/^"[^"]*"\s*→\s*__SEARCH__:[^\n]*\n?/gm, "");
  }

  // Remove the === SIGNALS === header when all blocks are stripped
  // (the section is now empty).
  if (stripEscalate && stripSearch) {
    text = text.replace(/^=== SIGNALS ===\n?/m, "");
  }

  // Collapse runs of 3+ blank lines down to 2.
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Resolves runtime placeholders in a system prompt template.
 * Called per-request so values like the current date are always fresh.
 * @param {string} template
 * @param {string} [appendBlock]
 * @returns {string}
 */
export function resolveDynamicPrompt(template, appendBlock = "") {
  const date = new Date().toISOString().slice(0, 10); // e.g. "2026-05-05"
  const resolved = template.replaceAll("{{CURRENT_DATE}}", date);
  const appendedBlock = String(appendBlock ?? "").trim();
  return appendedBlock ? `${resolved}\n\n${appendedBlock}` : resolved;
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
  maxTokens:      parseInt(  optional("LLM_MAX_TOKENS",         "2048"), 10),
  reasoningBudget: parseInt( optional("LLM_REASONING_BUDGET",   "-1"),   10),
};

/**
 * Builds per-model inference params, falling back to the global defaults.
 * Must be called AFTER _llamaGlobals is defined.
 * @param {'REMOTE'|'LOCAL'} suffix  - uppercase role suffix
 */
function inferenceParams(suffix) {
  return {
    temperature:   parseFloat(optional(`LLM_TEMPERATURE_${suffix}`,    String(_llamaGlobals.temperature))),
    topP:          parseFloat(optional(`LLM_TOP_P_${suffix}`,          String(_llamaGlobals.topP))),
    topK:          parseInt(  optional(`LLM_TOP_K_${suffix}`,          String(_llamaGlobals.topK)),   10),
    minP:          parseFloat(optional(`LLM_MIN_P_${suffix}`,          String(_llamaGlobals.minP))),
    repeatPenalty: parseFloat(optional(`LLM_REPEAT_PENALTY_${suffix}`, String(_llamaGlobals.repeatPenalty))),
    maxTokens:      parseInt(  optional(`LLM_MAX_TOKENS_${suffix}`,      String(_llamaGlobals.maxTokens)),      10),
    reasoningBudget: parseInt( optional(`LLM_REASONING_BUDGET_${suffix}`, String(_llamaGlobals.reasoningBudget)), 10),
  };
}

// ── OpenRouter per-role config ────────────────────────────────────────────────
// OpenRouter is an OpenAI-compatible inference provider used as an alternative
// backend per role.  Inference params fall back to the same llama globals so a
// role without OpenRouter-specific overrides still behaves sensibly.

/**
 * Builds OpenRouter inference params for a role, falling back to the global
 * llama defaults.  Only the OpenAI/OpenRouter-safe subset is collected here
 * (temperature, top_p, top_k, max_tokens); llama.cpp-only fields such as
 * min_p, repeat_penalty, n_keep and budget_tokens are intentionally excluded.
 * @param {'REMOTE'|'LOCAL'} suffix
 */
function openrouterParams(suffix) {
  return {
    temperature: parseFloat(optional(`OPENROUTER_TEMPERATURE_${suffix}`, String(_llamaGlobals.temperature))),
    topP:        parseFloat(optional(`OPENROUTER_TOP_P_${suffix}`,       String(_llamaGlobals.topP))),
    topK:        parseInt(  optional(`OPENROUTER_TOP_K_${suffix}`,       String(_llamaGlobals.topK)), 10),
    maxTokens:   parseInt(  optional(`OPENROUTER_MAX_TOKENS_${suffix}`,  String(_llamaGlobals.maxTokens)), 10),
  };
}

/**
 * Builds the per-role OpenRouter config (enabled flag, priority, model slug,
 * context size, fetch timeout, inference params).
 * @param {'REMOTE'|'LOCAL'} suffix
 * @param {string} defaultModel
 */
function openrouterRole(suffix, defaultModel) {
  const priorityRaw = optional(`OPENROUTER_${suffix}_PRIORITY`, "llama").trim().toLowerCase();
  return {
    enabled:  optional(`OPENROUTER_${suffix}_ENABLED`, "false") === "true",
    // Which backend a role tries first; the other is the automatic fallback.
    priority: priorityRaw === "openrouter" ? "openrouter" : "llama",
    model:    optional(`OPENROUTER_${suffix}_MODEL`, defaultModel),
    contextSize: parseInt(optional(`OPENROUTER_${suffix}_CONTEXT_SIZE`, "8192"), 10) || 0,
    fetchTimeoutMs: parseInt(
      optional(`OPENROUTER_${suffix}_FETCH_TIMEOUT_MS`, String(_timeoutFallback)),
      10
    ),
    params: openrouterParams(suffix),
  };
}

// ── Discord token resolution ──────────────────────────────────────────────────
// DISCORD_TOKEN_REMOTE is the canonical name for the remote bot token.
// Falls back to DISCORD_TOKEN for backward compatibility (logs a deprecation
// warning at startup when the fallback is used).

const _discordTokenRemote = (() => {
  if (process.env.DISCORD_TOKEN_REMOTE) return process.env.DISCORD_TOKEN_REMOTE;
  if (process.env.DISCORD_TOKEN) {
    // Deprecation warning is emitted later, after the logger is available.
    // We set a flag here so we can log it in index.js.
    process.env._DISCORD_TOKEN_DEPRECATED = "1";
    return process.env.DISCORD_TOKEN;
  }
  throw new Error(
    "Missing required environment variable: DISCORD_TOKEN_REMOTE " +
    "(set DISCORD_TOKEN_REMOTE for the remote bot; legacy DISCORD_TOKEN is also accepted but deprecated)"
  );
})();

function normalizeMcpTransport(value, fallback = "streamable-http") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "sse" || normalized === "streamable-http") return normalized;
  throw new Error(
    `Invalid MCP transport "${value}". Allowed values are "streamable-http" or "sse".`
  );
}

function pushUniqueMcpServer(servers, seenNames, server) {
  if (seenNames.has(server.name)) {
    throw new Error(
      `Duplicate MCP server name "${server.name}". Every MCP server name must be unique.`
    );
  }
  seenNames.add(server.name);
  servers.push(server);
}

function logConfigDebug(message) {
  if (optional("LOG_LEVEL", "info").toLowerCase() !== "debug") return;
  console.log(`[config] ${message}`);
}

function normalizeGitBookMcpUrl(rawUrl, sourceEnvKey) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/g, "");
    if (/\/~gitbook\/mcp$/i.test(path)) {
      parsed.pathname = path;
      return parsed.toString();
    }

    parsed.pathname = `${path}/~gitbook/mcp`;
    const normalized = parsed.toString();
    logConfigDebug(`[mcp] normalized ${sourceEnvKey}: "${trimmed}" -> "${normalized}"`);
    return normalized;
  } catch (err) {
    logConfigDebug(`[mcp] URL parsing failed for ${sourceEnvKey}: "${trimmed}" (${err.message})`);
    if (/\/~gitbook\/mcp\/?$/i.test(trimmed)) {
      return trimmed.replace(/\/+$/g, "");
    }

    const normalized = `${trimmed.replace(/\/+$/g, "")}/~gitbook/mcp`;
    logConfigDebug(`[mcp] normalized ${sourceEnvKey}: "${trimmed}" -> "${normalized}"`);
    return normalized;
  }
}

function normalizeMintlifyMcpUrl(rawUrl, sourceEnvKey) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/g, "");
    if (/\/mcp$/i.test(path)) {
      parsed.pathname = path;
      return parsed.toString();
    }

    parsed.pathname = `${path}/mcp`;
    const normalized = parsed.toString();
    logConfigDebug(`[mcp] normalized ${sourceEnvKey}: "${trimmed}" -> "${normalized}"`);
    return normalized;
  } catch (err) {
    logConfigDebug(`[mcp] URL parsing failed for ${sourceEnvKey}: "${trimmed}" (${err.message})`);
    if (/\/mcp\/?$/i.test(trimmed)) {
      return trimmed.replace(/\/+$/g, "");
    }

    const normalized = `${trimmed.replace(/\/+$/g, "")}/mcp`;
    logConfigDebug(`[mcp] normalized ${sourceEnvKey}: "${trimmed}" -> "${normalized}"`);
    return normalized;
  }
}

function buildMcpServers() {
  /** @type {Array<{name: string, url: string, transport: "streamable-http"|"sse", label?: string, headers?: Record<string, string>}>} */
  const servers = [];
  const seenNames = new Set();

  if (optional("MCP_COINGECKO_ENABLED", "false") === "true") {
    const cgApiKey = optional("MCP_COINGECKO_API_KEY", "").trim();
    const cgUrl = optional("MCP_COINGECKO_URL", "https://mcp.api.coingecko.com/").trim();
    const cgLabel = optional("MCP_COINGECKO_LABEL", "crypto prices and market data").trim();
    pushUniqueMcpServer(servers, seenNames, {
      name: "coingecko",
      url: cgUrl,
      transport: "streamable-http",
      label: cgLabel,
      ...(cgApiKey ? { headers: { "x-cg-pro-api-key": cgApiKey } } : {}),
    });
  }

  if (optional("MCP_GITBOOK_ENABLED", "false") === "true") {
    const gitbookTransport = normalizeMcpTransport(optional("MCP_GITBOOK_TRANSPORT", "streamable-http"));
    const sharedGitbookToken = optional("MCP_GITBOOK_TOKEN", "").trim();
    let hasNumberedGitbookUrl = false;

    for (let i = 1; i <= 10; i++) {
      const envKey = `MCP_GITBOOK_URL_${i}`;
      const gitbookUrlRaw = optional(envKey, "").trim();
      if (!gitbookUrlRaw) continue;
      hasNumberedGitbookUrl = true;

      const token = optional(`MCP_GITBOOK_TOKEN_${i}`, "").trim() || sharedGitbookToken;
      const label = optional(`MCP_GITBOOK_LABEL_${i}`, "").trim();
      pushUniqueMcpServer(servers, seenNames, {
        name: `gitbook-${i}`,
        url: normalizeGitBookMcpUrl(gitbookUrlRaw, envKey),
        transport: gitbookTransport,
        label,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
    }

    if (!hasNumberedGitbookUrl) {
      const gitbookUrlLegacy = optional("MCP_GITBOOK_URL", "").trim();
      if (!gitbookUrlLegacy) {
        throw new Error("MCP_GITBOOK_ENABLED=true requires MCP_GITBOOK_URL_1..10 or legacy MCP_GITBOOK_URL to be set.");
      }
      const token = optional("MCP_GITBOOK_TOKEN", "").trim();
      pushUniqueMcpServer(servers, seenNames, {
        name: "gitbook-1",
        url: normalizeGitBookMcpUrl(gitbookUrlLegacy, "MCP_GITBOOK_URL"),
        transport: gitbookTransport,
        label: optional("MCP_GITBOOK_LABEL_1", "").trim(),
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
    }
  }

  if (optional("MCP_MINTLIFY_ENABLED", "false") === "true") {
    const mintlifyTransport = normalizeMcpTransport(optional("MCP_MINTLIFY_TRANSPORT", "streamable-http"));
    const sharedMintlifyToken = optional("MCP_MINTLIFY_TOKEN", "").trim();
    let hasNumberedMintlifyUrl = false;

    for (let i = 1; i <= 10; i++) {
      const envKey = `MCP_MINTLIFY_URL_${i}`;
      const mintlifyUrlRaw = optional(envKey, "").trim();
      if (!mintlifyUrlRaw) continue;
      hasNumberedMintlifyUrl = true;

      const token = optional(`MCP_MINTLIFY_TOKEN_${i}`, "").trim() || sharedMintlifyToken;
      const label = optional(`MCP_MINTLIFY_LABEL_${i}`, "").trim();
      pushUniqueMcpServer(servers, seenNames, {
        name: `mintlify-${i}`,
        url: normalizeMintlifyMcpUrl(mintlifyUrlRaw, envKey),
        transport: mintlifyTransport,
        label,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
    }

    if (!hasNumberedMintlifyUrl) {
      const mintlifyUrlLegacy = optional("MCP_MINTLIFY_URL", "").trim();
      if (!mintlifyUrlLegacy) {
        throw new Error("MCP_MINTLIFY_ENABLED=true requires MCP_MINTLIFY_URL_1..10 or legacy MCP_MINTLIFY_URL to be set.");
      }
      const token = optional("MCP_MINTLIFY_TOKEN", "").trim();
      pushUniqueMcpServer(servers, seenNames, {
        name: "mintlify-1",
        url: normalizeMintlifyMcpUrl(mintlifyUrlLegacy, "MCP_MINTLIFY_URL"),
        transport: mintlifyTransport,
        label: optional("MCP_MINTLIFY_LABEL_1", "").trim(),
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
    }
  }

  for (let i = 1; i <= 10; i++) {
    const name = optional(`MCP_SERVER_${i}_NAME`, "").trim();
    const url = optional(`MCP_SERVER_${i}_URL`, "").trim();
    if (!name || !url) continue;

    const apiKey = optional(`MCP_SERVER_${i}_API_KEY`, "").trim();
    const label = optional(`MCP_SERVER_${i}_LABEL`, "").trim();
    pushUniqueMcpServer(servers, seenNames, {
      name,
      url,
      transport: normalizeMcpTransport(optional(`MCP_SERVER_${i}_TRANSPORT`, "streamable-http")),
      label,
      ...(apiKey ? { headers: { "x-api-key": apiKey } } : {}),
    });
  }

  return servers;
}

function normalizeDocsPostSearchMode(value) {
  const mode = String(value ?? "auto").trim().toLowerCase();
  if (mode === "snippets" || mode === "snippet") return "snippets";
  if (mode === "getpage" || mode === "get_page" || mode === "page") return "getPage";
  return "auto";
}

export const config = {
  discord: {
    // Bot #1 — Remote model (always-on VPS)
    tokenRemote: _discordTokenRemote,
    // Bot #2 — Local model (optional)
    tokenLocal: optional("DISCORD_TOKEN_LOCAL", ""),
    allowedChannelIds: optional("ALLOWED_CHANNEL_IDS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  vpsLlama: {
    // Set to false to skip auto-launching llama-server (manage it externally instead)
    enabled: optional("VPS_LLAMA_ENABLED", "true") !== "false",
    // Path to the llama-server binary
    bin: optional("VPS_LLAMA_BIN", "./llama/llama-server"),
    // Full path to the GGUF model file for the VPS instance (required when enabled)
    modelPath: optional("VPS_MODEL_PATH", ""),
  },
  llama: {
    // Remote llama-server — always on, always available (Bot #1)
    remoteUrl: optional("VPS_LLAMA_URL", "http://localhost:8080/v1"),
    remoteModelFile: optional("VPS_MODEL_FILE", "phi4-mini.Q4_K_M.gguf"),

    // Local llama-server — via Tailscale, managed by the local agent (Bot #2)
    localUrl: optional("LOCAL_LLAMA_URL", ""),

    // Local agent — manages the llama-server process on the local machine
    agentUrl: optional("LOCAL_AGENT_URL", ""),
    agentToken: optional("LOCAL_AGENT_TOKEN", ""),

    // Local model filename (passed to agent to load into llama-server)
    localModelFile: optional("LOCAL_MODEL_FILE",
      // Backward compat: fall back to the old COMMON var
      optional("LOCAL_MODEL_COMMON_FILE", "")
    ),

    // Global inference parameters (used as fallback for per-model params below)
    ..._llamaGlobals,

    // Timeout for a single LLM fetch request in ms (0 = no timeout) — global fallback
    fetchTimeoutMs: _timeoutFallback,

    // ── Per-model llama.cpp extra args (passed to agent /start) ──────────────
    // Falls back to LLAMA_EXTRA_ARGS if the role-specific var is not set.
    extraArgsRemote: optional("LLAMA_EXTRA_ARGS_REMOTE",
      optional("LLAMA_EXTRA_ARGS_VPS", _extraArgsFallback)
    ),
    extraArgsLocal:  optional("LLAMA_EXTRA_ARGS_LOCAL",
      // Backward compat: fall back to the old COMMON var
      optional("LLAMA_EXTRA_ARGS_COMMON", _extraArgsFallback)
    ),

    // ── Per-model context size (passed to agent /start) ───────────────────────
    // Falls back to LLAMA_CONTEXT_SIZE if the role-specific var is not set.
    contextSizeRemote: parseInt(optional("LLAMA_CONTEXT_SIZE_REMOTE",
      optional("LLAMA_CONTEXT_SIZE_VPS", _ctxFallback)
    ), 10) || 0,
    contextSizeLocal:  parseInt(
      optional("LLAMA_CONTEXT_SIZE_LOCAL",
        // Backward compat: fall back to the old COMMON var
        optional("LLAMA_CONTEXT_SIZE_COMMON", _ctxFallback)
      ),
      10
    ) || 0,

    // Per-slot context size used for trim budgeting.
    // When llama-server runs with --parallel N, the total context is split
    // across N slots.  Set these to (LLAMA_CONTEXT_SIZE_x / N) so the
    // context trimmer knows the real per-request limit.
    // Defaults to the total context size when not set (safe but may allow
    // prompts that exceed the actual slot capacity when parallel > 1).
    contextSlotSizeRemote: parseInt(optional("LLAMA_CONTEXT_SLOT_SIZE_REMOTE",
      optional("LLAMA_CONTEXT_SIZE_REMOTE", optional("LLAMA_CONTEXT_SIZE_VPS", _ctxFallback))
    ), 10) || 0,
    contextSlotSizeLocal: parseInt(optional("LLAMA_CONTEXT_SLOT_SIZE_LOCAL",
      optional("LLAMA_CONTEXT_SIZE_LOCAL", optional("LLAMA_CONTEXT_SIZE_COMMON", _ctxFallback))
    ), 10) || 0,

    // ── Per-model fetch timeouts ───────────────────────────────────────────────
    // Falls back to LLM_FETCH_TIMEOUT_MS if the role-specific var is not set.
    fetchTimeoutRemote: parseInt(optional("LLM_FETCH_TIMEOUT_MS_REMOTE",
      optional("LLM_FETCH_TIMEOUT_MS_VPS", String(_timeoutFallback))
    ), 10),
    fetchTimeoutLocal:  parseInt(
      optional("LLM_FETCH_TIMEOUT_MS_LOCAL",
        // Backward compat: fall back to the old COMMON var
        optional("LLM_FETCH_TIMEOUT_MS_COMMON", String(_timeoutFallback))
      ),
      10
    ),

    // ── Per-model inference parameters ────────────────────────────────────────
    // Each field falls back to the global value if the role-specific var is unset.
    paramsRemote: inferenceParams("REMOTE"),
    paramsLocal:  inferenceParams("LOCAL"),
  },
  openrouter: {
    // Shared OpenRouter settings. A role uses OpenRouter only when its
    // `enabled` flag is true AND `apiKey` is non-empty.
    apiKey:  optional("OPENROUTER_API_KEY", ""),
    baseUrl: optional("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    // Optional ranking headers (sent only when set) — see OpenRouter docs.
    referer: optional("OPENROUTER_HTTP_REFERER", ""),
    title:   optional("OPENROUTER_X_TITLE", ""),
    remote: openrouterRole("REMOTE", "google/gemma-4-26b-a4b-it:free"),
    local:  openrouterRole("LOCAL",  "google/gemma-4-31b-it:free"),

    // ── Retry settings specific to OpenRouter calls ───────────────────────────
    retry: {
      // How many times to attempt an OpenRouter call before giving up.
      // Falls back to the global RETRY_MAX_ATTEMPTS when not set.
      maxAttempts: parseInt(
        optional("OPENROUTER_RETRY_MAX_ATTEMPTS", optional("RETRY_MAX_ATTEMPTS", "3")),
        10
      ),
      // Initial exponential-backoff delay for non-429 failures (ms).
      initialDelayMs: parseInt(
        optional("OPENROUTER_RETRY_INITIAL_DELAY_MS", optional("RETRY_INITIAL_DELAY_MS", "500")),
        10
      ),
      // Fixed delay used for 429 rate-limit retries when the server does NOT
      // supply a Retry-After header.  Deliberately higher than the generic
      // backoff to respect rate-limit windows.
      rateLimitDelayMs: parseInt(optional("OPENROUTER_RETRY_RATE_LIMIT_DELAY_MS", "10000"), 10),
    },

    // ── Cross-role OR fallback mode ───────────────────────────────────────────
    // 0 = disabled — each role only falls back to its own llama-server.
    // 1 = local→remote only — if local OR fails, try the (lighter) remote OR
    //     model before falling back to llama.  Remote OR cannot fall back to
    //     local OR.
    // 2 = any direction — remote OR can fall back to local OR and vice versa.
    //     If both OR models fail, falls back to the role's llama-server.
    fallback: parseInt(optional("OPENROUTER_FALLBACK", "0"), 10),
  },
  llm: {
    systemPrompt:        buildSystemPrompt(loadSystemPrompt()),    // kept for backward compat
    systemPromptRemote:  buildSystemPrompt(loadSystemPromptRemote()),
    systemPromptLocal:   buildSystemPrompt(loadSystemPromptLocal()),
  },
  availability: {
    pollIntervalMs: parseInt(
      optional("LOCAL_HEALTH_POLL_INTERVAL_MS", "30000"),
      10
    ),
  },
  complexity: {
    // Minimum character count of a user prompt to be considered "long"
    promptLength: parseInt(optional("COMPLEXITY_PROMPT_LENGTH", "300"), 10),
    // Comma-separated keywords that indicate a code-related request
    keywordsCode: optional(
      "COMPLEXITY_KEYWORDS_CODE",
      "debug,refactor,implement,algorithm,function,class,compile,syntax,error,exception,stack trace,regex,sql,query,optimize"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Comma-separated keywords that indicate a planning / architecture request
    keywordsPlan: optional(
      "COMPLEXITY_KEYWORDS_PLAN",
      "architecture,design,plan,roadmap,strategy,system design,how to build,how to implement,step by step,guide me,walk me through"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  localPresence: {
    // How long (ms) the local bot stays Online after finishing a task before
    // returning to Idle.  0 = return to Idle immediately.
    cooldownMs: parseInt(optional("LOCAL_PRESENCE_COOLDOWN_MS", "30000"), 10),
    // How long (ms) the local model may be idle before being stopped.
    // 0 = never auto-stop (default).
    idleMs: parseInt(optional("LOCAL_MODEL_IDLE_MS", "0"), 10),
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
    // Max input tokens before history trimming kicks in (0 = disabled).
    // Separate limits per model — falls back to shared MAX_INPUT_TOKENS.
    maxInputTokensRemote: parseInt(optional("MAX_INPUT_TOKENS_REMOTE",
      optional("MAX_INPUT_TOKENS", "0")), 10),
    maxInputTokensLocal:  parseInt(optional("MAX_INPUT_TOKENS_LOCAL",
      optional("MAX_INPUT_TOKENS", "0")), 10),
  },
  rateLimit: {
    // Per-user: max N requests per window
    maxRequests: parseInt(optional("RATE_LIMIT_MAX_REQUESTS", "5"), 10),
    windowMs: parseInt(optional("RATE_LIMIT_WINDOW_MS", "30000"), 10),
    // Global: max simultaneous LLM calls in flight
    maxConcurrent: parseInt(optional("MAX_CONCURRENT_REQUESTS", "1"), 10),
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
  mcp: {
    enabled: optional("MCP_ENABLED", "false") === "true",
    servers: buildMcpServers(),
  },
  contextTrim: {
    safetyMargin: parseInt(optional("CONTEXT_TRIM_SAFETY_MARGIN", "512"), 10),
    minMessageBudget: parseInt(optional("CONTEXT_TRIM_MIN_MESSAGE_BUDGET", "512"), 10),
  },
  docs: {
    // After docs search: "auto" (broad + good snippets → digest, else getPage),
    // "snippets" (never auto-getPage), "getPage" (always fetch full page when possible).
    postSearchMode: normalizeDocsPostSearchMode(optional("DOCS_POST_SEARCH_MODE", "auto")),
    maxSnippetHits: Math.min(
      10,
      Math.max(1, parseInt(optional("DOCS_MAX_SNIPPET_HITS", "4"), 10) || 4)
    ),
    minSnippetChars: Math.max(0, parseInt(optional("DOCS_MIN_SNIPPET_CHARS", "400"), 10) || 400),
    minSearchConfidenceScore: Number(optional("DOCS_MIN_SEARCH_CONFIDENCE_SCORE", "8")) || 8,
    minSearchConfidenceGap: Number(optional("DOCS_MIN_SEARCH_CONFIDENCE_GAP", "2")) || 2,
  },
  logLevel: optional("LOG_LEVEL", "info"),
  logRaw:   optional("LOG_RAW",   "false") === "true",
};
