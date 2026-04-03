import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Calls the Ollama /api/chat endpoint.
 *
 * @param {string} baseUrl  - e.g. "http://localhost:11434"
 * @param {string} model    - model name
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]   - optional overrides: keep_alive, num_predict, etc.
 * @returns {Promise<string>} - the assistant's response text
 */
export async function ollamaChat(baseUrl, model, messages, opts = {}) {
  const { keepAlive, ...extraOpts } = opts;

  const body = {
    model,
    messages,
    stream: false,
    options: {
      temperature: config.ollama.temperature,
      top_p: config.ollama.topP,
      top_k: config.ollama.topK,
      min_p: config.ollama.minP,
      repeat_penalty: config.ollama.repeatPenalty,
      num_predict: config.ollama.maxTokens > 0 ? config.ollama.maxTokens : -1,
      ...extraOpts,
    },
  };

  if (keepAlive !== undefined) {
    body.keep_alive = keepAlive;
  }

  logger.debug(
    `ollamaChat → ${baseUrl} model=${model} messages=${messages.length} keep_alive=${keepAlive ?? "(default)"}`
  );

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ollama /api/chat failed: ${res.status} ${res.statusText} — ${text}`
    );
  }

  const data = await res.json();
  const content = data?.message?.content ?? "";
  logger.debug(`ollamaChat ← ${content.length} chars`);
  return content.trim();
}

/**
 * Unloads a model from Ollama by sending a chat request with keep_alive=0.
 *
 * @param {string} baseUrl
 * @param {string} model
 */
export async function ollamaUnload(baseUrl, model) {
  logger.info(`Unloading model "${model}" from ${baseUrl}`);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        `Unload request for "${model}" returned ${res.status}: ${text}`
      );
    }
  } catch (err) {
    logger.warn(`Failed to unload model "${model}": ${err.message}`);
  }
}
