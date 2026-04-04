import { config } from "../config.js";
import { logger } from "../logger.js";

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

  logger.debug(
    `llamaChat → ${baseUrl} messages=${messages.length}`
  );

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unable to read error details)");
    throw new Error(
      `llama-server /chat/completions failed: ${res.status} ${res.statusText} — ${text}`
    );
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  logger.debug(`llamaChat ← ${content.length} chars`);
  return content.trim();
}
