import { config } from "../config.js";
import { logger } from "../logger.js";
import { withRetry } from "../utils/retry.js";

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

  const body = {
    messages,
    stream: false,
    ...bodyOpts,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
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
