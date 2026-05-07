import { config } from "../config.js";
import { logger } from "../logger.js";
import { withRetry } from "../utils/retry.js";
import { getMcpTools, callMcpTool } from "./mcpService.js";

const MAX_TOOL_ROUNDS = 5;

function sanitizeToolErrorMessage(err) {
  const msg = err?.message ? String(err.message) : "unknown error";
  return /(token|secret|password|api[_-]?key|authorization|auth|bearer|cookie|session)/i.test(msg)
    ? "tool execution failed due to a protected error"
    : msg;
}

/**
 * @param {string} baseUrl
 * @param {Array} messages
 * @param {object} opts
 * @param {Array} tools
 * @returns {Promise<{ content: string|null, tool_calls: Array|null }>}
 */
async function llamaChatRaw(baseUrl, messages, opts = {}, tools = []) {
  const { fetchTimeout: optsFetchTimeout, ...bodyOpts } = opts;

  const body = {
    messages,
    stream: false,
    ...bodyOpts,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };

  const effectiveTimeoutMs =
    optsFetchTimeout !== undefined ? optsFetchTimeout : config.llama.fetchTimeoutMs;

  logger.debug(`[tool-call] llamaChatRaw → ${baseUrl} messages=${messages.length} tools=${tools.length}`);

  return await withRetry(
    async () => {
      const signal = effectiveTimeoutMs > 0 ? AbortSignal.timeout(effectiveTimeoutMs) : undefined;

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
        err.statusCode = res.status;
        throw err;
      }

      const data = await res.json();

      const usage = data?.usage;
      if (usage) {
        logger.debug(
          `[tool-call] tokens — prompt:${usage.prompt_tokens ?? "?"} ` +
            `completion:${usage.completion_tokens ?? "?"} ` +
            `total:${usage.total_tokens ?? "?"}`
        );
      }

      const message = data?.choices?.[0]?.message;
      const toolCalls = message?.tool_calls?.length ? message.tool_calls : null;
      const content = message?.content ? message.content.trim() : null;

      return { content, tool_calls: toolCalls };
    },
    {
      maxAttempts: config.retry.maxAttempts,
      initialDelayMs: config.retry.initialDelayMs,
      label: `llamaChatRaw(${baseUrl})`,
      shouldRetry: (err) => !err.statusCode || err.statusCode >= 500,
    }
  );
}

/**
 * @param {string} baseUrl
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function llamaWithTools(baseUrl, messages, opts = {}) {
  const tools = getMcpTools();

  if (!config.mcp.enabled || tools.length === 0) {
    const { content } = await llamaChatRaw(baseUrl, messages, opts, []);
    return content ?? "";
  }

  const currentMessages = [...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { content, tool_calls } = await llamaChatRaw(baseUrl, currentMessages, opts, tools);

    logger.debug(`[tool-call] round=${round + 1} tool_calls=${tool_calls?.length ?? 0}`);

    if (!tool_calls || tool_calls.length === 0) {
      return content ?? "";
    }

    currentMessages.push({
      role: "assistant",
      content: content ?? null,
      tool_calls,
    });

    for (const tc of tool_calls) {
      let toolResult;
      try {
        const args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : (tc.function.arguments ?? {});
        toolResult = await callMcpTool(tc.function.name, args);
      } catch (err) {
        const safeMessage = sanitizeToolErrorMessage(err);
        logger.warn(`[tool-call] Tool ${tc.function.name} failed: ${safeMessage}`);
        toolResult = `Error calling tool ${tc.function.name}: ${safeMessage}`;
      }

      currentMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolResult,
      });
    }
  }

  logger.warn(`[tool-call] Exceeded MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) — calling without tools`);
  const { content } = await llamaChatRaw(baseUrl, currentMessages, opts, []);
  return content ?? "";
}
