import { config } from "../config.js";
import { logger } from "../logger.js";
import { withRetry } from "../utils/retry.js";

/**
 * Calls a llama-server OpenAI-compatible /v1/chat/completions endpoint.
 *
 * @param {string} baseUrl  - OpenAI-compat API base, including the /v1 prefix
 *                            e.g. "http://localhost:8080/v1"
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]   - optional overrides merged into the request body
 * @returns {Promise<string>} - the assistant's response text
 */
export async function llamaChat(baseUrl, messages, opts = {}) {
  // Extract fetchTimeout before spreading opts into the API request body.
  // fetchTimeout is a bot-level control; it must not be sent to llama-server.
  const { fetchTimeout: optsFetchTimeout, ...bodyOpts } = opts;

  const body = {
    messages,
    stream: false,
    ...bodyOpts,
  };

  // Per-call timeout takes priority; falls back to global config.
  const effectiveTimeoutMs =
    optsFetchTimeout !== undefined ? optsFetchTimeout : config.llama.fetchTimeoutMs;

  logger.debug(`llamaChat → ${baseUrl} messages=${messages.length}`);

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

        const content = data?.choices?.[0]?.message?.content ?? "";
        logger.debug(`llamaChat ← ${content.length} chars`);
        return content.trim();
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
