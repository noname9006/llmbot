import OpenAI from "openai";
import { config } from "../config.js";
import { logger } from "../logger.js";

const client = new OpenAI({
  baseURL: config.llm.baseUrl,
  // LM Studio doesn't require an API key, but the SDK requires a non-empty string
  apiKey: "lm-studio",
});

/**
 * Calls the LLM with the given messages and streams the response.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {function(string): void} onChunk  - called for each streamed token chunk
 * @returns {Promise<string>}               - the full completed response
 */
export async function streamCompletion(messages, onChunk) {
  logger.debug(
    `Sending ${messages.length} messages to LLM (model: ${config.llm.model})`
  );

  const stream = await client.chat.completions.create({
    model: config.llm.model,
    messages,
    stream: true,
    max_tokens: config.llm.maxTokens > 0 ? config.llm.maxTokens : undefined,
    temperature: config.llm.temperature,
  });

  let fullText = "";

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      fullText += delta;
      onChunk(delta);
    }
  }

  logger.debug(`LLM response complete. Total chars: ${fullText.length}`);
  return fullText;
}

/**
 * Quick health-check: can we reach LM Studio?
 * @returns {Promise<boolean>}
 */
export async function checkHealth() {
  try {
    const models = await client.models.list();
    logger.info(
      `LM Studio reachable. Available models: ${models.data.map((m) => m.id).join(", ")}`
    );
    return true;
  } catch (err) {
    logger.error("LM Studio health check failed:", err.message);
    return false;
  }
}
