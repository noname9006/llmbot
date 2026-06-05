import { config } from "../config.js";
import { logger } from "../logger.js";
import { withRetry } from "../utils/retry.js";
import { toolsForApiPayload } from "../utils/contextBudget.js";

// ── n_keep cache ──────────────────────────────────────────────
/** @type {Map<string, number>} */
const nKeepCache = new Map();

/**
 * Measures or returns cached n_keep for the given base URL, system message,
 * and tools. The value is `usage.prompt_tokens` from a minimal inference
 * request sent with the exact same system prompt and tools, so it reflects
 * the real token count including any server-side tool-schema injection.
 *
 * Cached per (baseUrl, date, tools.length) and invalidated when the calendar
 * date changes because `{{CURRENT_DATE}}` shifts the prompt.
 *
 * @param {string} baseUrl
 * @param {{role: string, content: string}} systemMessage
 * @param {Array} tools
 * @returns {Promise<number>} measured token count, or 0 on failure
 */
async function resolveNKeep(baseUrl, systemMessage, tools) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const cacheKey = `${baseUrl}:${today}:${tools.length}`;

  const cached = nKeepCache.get(cacheKey);
  if (cached !== undefined) {
    logger.debug(`[nkeep] Cache hit ${cacheKey}: ${cached}`);
    return cached;
  }

  const measurementBody = {
    messages: [systemMessage, { role: "user", content: "." }],
    stream: false,
    max_tokens: 1,
    ...(tools.length > 0 ? { tools: toolsForApiPayload(tools), tool_choice: "auto" } : {}),
  };

  let promptTokens = 0;
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(measurementBody),
      signal: AbortSignal.timeout(30000),
    });

    if (res.ok) {
      const data = await res.json();
      promptTokens = data?.usage?.prompt_tokens ?? 0;
      if (promptTokens > 0) {
        logger.info(`[nkeep] Measured ${promptTokens} tokens for ${baseUrl} (${today}, tools=${tools.length})`);
      }
    } else {
      logger.warn(`[nkeep] Measurement request failed (${res.status}) for ${baseUrl}`);
    }
  } catch (err) {
    logger.warn(`[nkeep] Measurement error for ${baseUrl}: ${err.message}`);
  }

  if (promptTokens > 0) {
    nKeepCache.set(cacheKey, promptTokens);
  }
  return promptTokens;
}

/**
 * Eagerly pre-warms the n_keep cache for a given base URL, system prompt
 * and tool set. Call once after MCP tools are loaded so the first real
 * user request never pays the measurement latency.
 *
 * @param {string} baseUrl
 * @param {{role: string, content: string}} systemMessage
 * @param {Array} [tools]
 * @returns {Promise<number>}
 */
export async function prewarmNKeep(baseUrl, systemMessage, tools = []) {
  return resolveNKeep(baseUrl, systemMessage, tools);
}

/**
 * Calls a llama-server OpenAI-compatible /v1/chat/completions endpoint.
 *
 * @param {string} baseUrl  - OpenAI-compat API base, including the /v1 prefix
 *                            e.g. "http://localhost:8080/v1"
 * @param {Array} messages
 * @param {object} [opts]   - optional overrides merged into the request body
 * @param {Array} [tools]
 * @returns {Promise<{ content: string|null, tool_calls: Array|null }>}
 */
export async function llamaChatCompletion(baseUrl, messages, opts = {}, tools = []) {
  // Extract fetchTimeout before spreading opts into the API request body.
  // fetchTimeout is a bot-level control; it must not be sent to llama-server.
  const { fetchTimeout: optsFetchTimeout, ...bodyOpts } = opts;

  // Resolve n_keep from the first system message so the server never shifts
  // the system prompt out of the KV cache.
  let nKeep = null;
  if (messages[0]?.role === "system") {
    nKeep = await resolveNKeep(baseUrl, messages[0], tools);
  }

  const body = {
    messages,
    stream: false,
    ...(nKeep ? { n_keep: nKeep } : {}),
    ...bodyOpts,
    ...(tools.length > 0 ? { tools: toolsForApiPayload(tools), tool_choice: "auto" } : {}),
  };

  // Per-call timeout takes priority; falls back to global config.
  const effectiveTimeoutMs =
    optsFetchTimeout !== undefined ? optsFetchTimeout : config.llama.fetchTimeoutMs;

  const paramSummary = [
    bodyOpts.temperature  !== undefined ? `temp=${bodyOpts.temperature}`           : null,
    bodyOpts.top_k        !== undefined ? `top_k=${bodyOpts.top_k}`                : null,
    bodyOpts.max_tokens   !== undefined ? `max_tokens=${bodyOpts.max_tokens}`      : null,
    bodyOpts.budget_tokens !== undefined ? `budget_tokens=${bodyOpts.budget_tokens}` : null,
    `tools=${tools.length}`,
  ].filter(Boolean).join(" ");

  logger.debug(`llamaChat → ${baseUrl} messages=${messages.length}${paramSummary ? ` [${paramSummary}]` : ""}`);

  const done = logger.timer(`llamaChat (${baseUrl})`, "debug");

  try {
    return await withRetry(
      async () => {
        const signal =
          effectiveTimeoutMs > 0
            ? AbortSignal.timeout(effectiveTimeoutMs)
            : undefined;

        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "(unable to read error details)");
          const err = new Error(
            `llama-server /chat/completions failed: ${res.status} ${res.statusText} — ${text}`
          );
          // Don't retry client errors (4xx)
          err.statusCode = res.status;
          throw err;
        }

        const data = await res.json();

        // Log token usage when the server provides it
        const usage = data?.usage;
        if (usage) {
          logger.debug(
            `llamaChat tokens — prompt:${usage.prompt_tokens ?? "?"} ` +
              `completion:${usage.completion_tokens ?? "?"} ` +
              `total:${usage.total_tokens ?? "?"}`
          );
        }

        const message = data?.choices?.[0]?.message;
        const toolCalls = message?.tool_calls?.length ? message.tool_calls : null;
        const content = typeof message?.content === "string" ? message.content.trim() : null;
        logger.debug(`llamaChat ← ${content?.length ?? 0} chars tool_calls=${toolCalls?.length ?? 0}`);
        return { content, tool_calls: toolCalls };
      },
      {
        maxAttempts: config.retry.maxAttempts,
        initialDelayMs: config.retry.initialDelayMs,
        label: `llamaChat(${baseUrl})`,
        // Retry on network errors and 5xx; abort on 4xx
        shouldRetry: (err) => !err.statusCode || err.statusCode >= 500,
      }
    );
  } finally {
    // Always log elapsed time — success or all-retries-exhausted failure
    done();
  }
}

/**
 * Backward-compatible text-only wrapper.
 *
 * @param {string} baseUrl
 * @param {Array} messages
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function llamaChat(baseUrl, messages, opts = {}) {
  const { content } = await llamaChatCompletion(baseUrl, messages, opts, []);
  return content ?? "";
}
