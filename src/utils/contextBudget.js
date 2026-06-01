/**
 * Rough token estimates for context budgeting (1 token ≈ 4 chars).
 * Used to stay under llama-server n_ctx before requests are sent.
 */

const TOOLS_ESTIMATE_MULTIPLIER = 1.1;

/**
 * @param {Array<{ type?: string, function?: object, _serverName?: string, _originalName?: string }>} tools
 * @returns {Array<{ type: string, function: object }>}
 */
export function toolsForApiPayload(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools.map(({ type, function: fn }) => ({
    type: type ?? "function",
    function: fn,
  }));
}

/**
 * @param {object} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  if (!message) return 0;
  let sum = Math.ceil(String(message.content ?? "").length / 4);
  if (message.tool_calls?.length) {
    try {
      sum += Math.ceil(JSON.stringify(message.tool_calls).length / 4);
    } catch {
      sum += 64;
    }
  }
  return sum;
}

/**
 * @param {Array<object>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/**
 * @param {Array<object>} tools
 * @returns {number}
 */
export function estimateToolsTokens(tools) {
  if (!tools?.length) return 0;
  try {
    const json = JSON.stringify(toolsForApiPayload(tools));
    return Math.ceil((json.length / 4) * TOOLS_ESTIMATE_MULTIPLIER);
  } catch {
    return tools.length * 128;
  }
}

/**
 * @param {object} params
 * @param {number} params.nCtx
 * @param {number} params.maxTokensOut
 * @param {Array<object>} params.tools
 * @param {number} params.safetyMargin
 * @param {number} params.minMessageBudget
 * @returns {number}
 */
export function computeMessageTokenBudget({
  nCtx,
  maxTokensOut,
  tools = [],
  safetyMargin,
  minMessageBudget,
}) {
  if (!nCtx || nCtx <= 0) return 0;
  const reserved =
    Math.max(0, maxTokensOut) +
    estimateToolsTokens(tools) +
    Math.max(0, safetyMargin);
  const budget = nCtx - reserved;
  return Math.max(minMessageBudget, budget);
}
