import { config } from "../config.js";
import { logger } from "../logger.js";
import { getMcpTools, callMcpTool } from "./mcpService.js";
import { llamaChatCompletion } from "./llamaService.js";

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_RESULT_CHARS = 8_000;

function sanitizeToolErrorMessage(err) {
  const msg = err?.message ? String(err.message) : "unknown error";
  return /(token|secret|password|api[_-]?key|authorization|auth|bearer|cookie|session)/i.test(msg)
    ? "tool execution failed due to a protected error"
    : msg;
}

function normalizeToolResult(toolName, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    return text;
  }
  logger.warn(
    `[tool-call] Tool ${toolName} returned ${text.length} chars; truncating to ${MAX_TOOL_RESULT_CHARS}`
  );
  return (
    `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n` +
    `[truncated: tool output exceeded ${MAX_TOOL_RESULT_CHARS} characters]`
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
    const { content } = await llamaChatCompletion(baseUrl, messages, opts, []);
    return content ?? "";
  }

  const currentMessages = [...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { content, tool_calls } = await llamaChatCompletion(baseUrl, currentMessages, opts, tools);

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
        toolResult = normalizeToolResult(tc.function.name, await callMcpTool(tc.function.name, args));
      } catch (err) {
        const safeMessage = sanitizeToolErrorMessage(err);
        logger.warn(`[tool-call] Tool ${tc.function.name} failed: ${safeMessage}`);
        toolResult = normalizeToolResult(
          tc.function.name,
          `Error calling tool ${tc.function.name}: ${safeMessage}`
        );
      }

      currentMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolResult,
      });
    }
  }

  logger.warn(`[tool-call] Exceeded MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) — calling without tools`);
  const { content } = await llamaChatCompletion(baseUrl, currentMessages, opts, []);
  return content ?? "";
}
