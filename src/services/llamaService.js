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
  const body = {
    messages,
    stream: false,
    temperature: config.llama.temperature,
    top_p: config.llama.topP,
    top_k: config.llama.topK,
    min_p: config.llama.minP,
    repeat_penalty: config.llama.repeatPenalty,
    max_tokens: config.llama.maxTokens > 0 ? config.llama.maxTokens : -1,
    ...opts,
  };

  logger.debug(`llamaChat → ${baseUrl} messages=${messages.length}`);

  const done = logger.timer(`llamaChat (${baseUrl})`, "debug");

  try {
    return await withRetry(
      async () => {
        const signal =
          config.llama.fetchTimeoutMs > 0
            ? AbortSignal.timeout(config.llama.fetchTimeoutMs)
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

        // 1. Strip <think>...</think> reasoning blocks (Qwen3.5 and other thinking models)
        //    Handles empty blocks (<think>\n\n</think>) and non-empty ones.
        //    The \s* after </think> eats the blank line that follows.
        let sanitized = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");

        // 2. Cut off at [/response] stop token (some models self-insert this but don't stop)
        //    Case-insensitive to handle [/RESPONSE] variants.
        const stopIdx = sanitized.search(/\[\/response\]/i);
        if (stopIdx !== -1) {
          sanitized = sanitized.slice(0, stopIdx);
        }

        logger.debug(`llamaChat ← ${sanitized.length} chars`);
        return sanitized.trim();
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
