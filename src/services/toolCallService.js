import { config } from "../config.js";
import { logger } from "../logger.js";
import { getMcpTools, callMcpTool } from "./mcpService.js";
import { llamaChatCompletion } from "./llamaService.js";

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_RESULT_CHARS = 8_000;

/** Patterns that indicate the model is narrating a future tool call instead of making one. */
const STALLING_PATTERNS = [
  /\b(let me|i('ll| will|'m going to)|gonna|going to|i need to)\s+(check|search|look|find|fetch|query|pull|get)\b/i,
  /\b(checking|searching|looking up|fetching|querying|pulling|running a search)\b/i,
  /\bhold on\b/i,
  /\bone (sec|second|moment|min|minute)\b/i,
  /\b(i gotta|gotta)\b.{0,20}\b(docs|documentation|data|info|search)\b/i,
  /\bgotta (run|do) the search\b/i,
  /\blmk when it comes back\b/i,
  /\bwhen it comes back\b/i,
];

function looksLikeStalling(content) {
  if (!content) return false;
  return STALLING_PATTERNS.some((re) => re.test(content));
}

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

function appendToolSourcesToFinalResponse(content, sourceUrls) {
  if (sourceUrls.size === 0) return content ?? "";
  const answer = content ?? "";
  const missingSources = [...sourceUrls].filter((url) => {
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sourceLineRe = new RegExp(`^Source:\\s*${escapedUrl}$`, "m");
    return !sourceLineRe.test(answer);
  });
  if (missingSources.length === 0) return answer;
  const sourceLines = missingSources.map((url) => `Source: ${url}`).join("\n");
  return answer.trim()
    ? `${answer.trimEnd()}\n\n${sourceLines}`
    : sourceLines;
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
  const sourceUrls = new Set();
  let stallingInjected = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { content, tool_calls } = await llamaChatCompletion(baseUrl, currentMessages, opts, tools);

    logger.debug(`[tool-call] round=${round + 1} tool_calls=${tool_calls?.length ?? 0}`);

    if (!tool_calls || tool_calls.length === 0) {
      // If the model emitted a stalling phrase without making a tool call,
      // inject a reminder once and retry so the tool actually runs.
      if (!stallingInjected && looksLikeStalling(content)) {
        logger.debug(`[tool-call] round=${round + 1} stalling detected — injecting tool reminder`);
        stallingInjected = true;
        currentMessages.push({ role: "assistant", content: content ?? null });
        currentMessages.push({
          role: "user",
          content: "Please call the appropriate tool now to get the information.",
        });
        continue;
      }
      return appendToolSourcesToFinalResponse(content, sourceUrls);
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
        const mcpToolResponse = await callMcpTool(tc.function.name, args);
        for (const sourceUrl of mcpToolResponse.sources ?? []) {
          sourceUrls.add(sourceUrl);
        }
        toolResult = normalizeToolResult(tc.function.name, mcpToolResponse.text);
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
  return appendToolSourcesToFinalResponse(content, sourceUrls);
}
