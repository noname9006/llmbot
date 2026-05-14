/**
 * MCP client service — connects to remote MCP servers (CoinGecko, GitBook, …)
 * and exposes their tools to the LLM via OpenAI tool-calling format.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const MCP_CONNECT_TIMEOUT_MS = 10_000;
const MCP_LIST_TOOLS_TIMEOUT_MS = 10_000;

// ── Prompt-injection guardrails ────────────────────────────────────────────────
// Maximum length (chars) for a single label or tool-name field injected into
// the system prompt.  Anything longer is silently truncated after sanitization.
const LABEL_MAX_LEN = 100;
const TOOL_NAME_MAX_LEN = 64;
// Hard ceiling for the entire context block injected into the system prompt.
const BLOCK_MAX_CHARS = 4_000;
const MAX_URL_EXTRACTION_DEPTH = 6;
const URL_FIELD_KEY_RE = /(uri|url|href|source)/i;
const TRAILING_URL_PUNCTUATION_RE = /[),.;:!?]+$/;

/**
 * Strips all ASCII control characters (0x00–0x1F, 0x7F) — including newlines
 * and carriage returns that could inject extra prompt lines — then trims
 * whitespace and truncates to maxLen.
 * Returns an empty string when the result is blank after sanitization.
 *
 * @param {unknown} text
 * @param {number}  maxLen
 * @returns {string}
 */
function sanitizeField(text, maxLen) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(text ?? "").replace(/[\x00-\x1F\x7F]/g, "").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trimEnd() : cleaned;
}

/** @type {Array<{ name: string, client: Client }>} */
const mcpClients = [];

/**
 * @type {Array<{
 *  type: "function",
 *  function: { name: string, description: string, parameters: object },
 *  _serverName: string,
 *  _originalName: string
 * }>}
 */
let cachedTools = [];

/**
 * @param {Array<{name: string, label?: string}>} servers
 * @param {Array<{_serverName: string, _originalName: string}>} tools
 * @param {string[]} connectedServerNames
 * @returns {string}
 */
export function buildMcpContextBlock(servers, tools, connectedServerNames) {
  const connectedSet = new Set(connectedServerNames);
  const toolNamesByServer = new Map();

  for (const tool of tools) {
    const sanitizedName = sanitizeField(tool._originalName, TOOL_NAME_MAX_LEN);
    if (!sanitizedName) continue;
    const list = toolNamesByServer.get(tool._serverName) ?? [];
    if (!list.includes(sanitizedName)) {
      list.push(sanitizedName);
      toolNamesByServer.set(tool._serverName, list);
    }
  }

  const lines = servers
    .filter((server) => connectedSet.has(server.name))
    .map((server) => ({
      name: server.name,
      label: sanitizeField(server.label ?? "", LABEL_MAX_LEN),
      tools: toolNamesByServer.get(server.name) ?? [],
    }))
    .filter((server) => server.label && server.tools.length > 0)
    .map(
      (server) =>
        `- ${server.name} (${server.label}): use ${server.tools.join(", ")} for specific questions about this topic`
    );

  if (lines.length === 0) {
    logger.debug("[mcp] buildMcpContextBlock: no labeled connected servers with tools — skipping context block");
    return "";
  }

  const hasCoingecko = servers.some((server) => {
    const isConnected = connectedSet.has(server.name);
    const isCoingecko = server.name === "coingecko";
    const hasTools = (toolNamesByServer.get(server.name)?.length ?? 0) > 0;
    return isConnected && isCoingecko && hasTools;
  });

  const block =
    "## Available knowledge tools:\n" +
    `${lines.join("\n")}\n` +
    "Prefer these tools over guessing for specific factual questions about the topics above." +
    (hasCoingecko
      ? "\nFor current cryptocurrency prices, market data, or coin information, ALWAYS use coingecko tools FIRST before considering web search."
      : "");

  if (block.length > BLOCK_MAX_CHARS) {
    logger.warn(
      `[mcp] buildMcpContextBlock: context block too large (${block.length} chars > ${BLOCK_MAX_CHARS} limit) — truncating`
    );
    return block.slice(0, BLOCK_MAX_CHARS);
  }

  logger.debug(`[mcp] buildMcpContextBlock: ${lines.length} server(s) included, block is ${block.length} chars`);
  return block;
}

async function withTimeout(promise, ms, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function safeArgsPreview(args) {
  try {
    const redacted = JSON.parse(JSON.stringify(args ?? {}, (key, value) => {
      if (/(token|secret|password|api[_-]?key|authorization|auth|bearer|cookie|session)/i.test(key)) {
        return "[REDACTED]";
      }
      return value;
    }));
    const json = JSON.stringify(redacted);
    return json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    return "[unserializable args]";
  }
}

/**
 * @param {string} serverName
 * @param {string} url
 * @param {"streamable-http"|"sse"} transport
 * @param {Record<string, string>} [headers]
 */
async function connectToServer(serverName, url, transport, headers = {}) {
  const client = new Client({ name: "llmbot-mcp-client", version: "1.0.0" });
  const urlObj = new URL(url);
  const transportInstance =
    transport === "sse"
      ? new SSEClientTransport(urlObj, { requestInit: { headers } })
      : new StreamableHTTPClientTransport(urlObj, { requestInit: { headers } });

  try {
    logger.info(`[mcp] Connecting to ${serverName} (${url}) via ${transport}…`);
    await withTimeout(
      client.connect(transportInstance),
      MCP_CONNECT_TIMEOUT_MS,
      `[mcp] Connect to ${serverName}`
    );
    logger.info(`[mcp] Connected to ${serverName}`);

    const { tools } = await withTimeout(
      client.listTools(),
      MCP_LIST_TOOLS_TIMEOUT_MS,
      `[mcp] listTools(${serverName})`
    );
    const toolNames = new Set(tools.map((t) => t.name));

    logger.info(`[mcp] ${serverName} provides ${tools.length} tool(s): ${[...toolNames].join(", ")}`);

    const prefixedTools = tools.map((t) => ({
      type: "function",
      function: {
        name: `${serverName}__${t.name}`,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
      _serverName: serverName,
      _originalName: t.name,
    }));

    mcpClients.push({ name: serverName, client });
    cachedTools.push(...prefixedTools);
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

export async function initMcp() {
  if (!config.mcp.enabled) {
    logger.debug("[mcp] MCP disabled — skipping init");
    return;
  }

  for (const server of config.mcp.servers) {
    try {
      await connectToServer(server.name, server.url, server.transport, server.headers ?? {});
    } catch (err) {
      logger.warn(`[mcp] Failed to connect to ${server.name}: ${err.message} — skipping`);
    }
  }

  logger.info(`[mcp] Ready — ${mcpClients.length} server(s) connected, ${cachedTools.length} tool(s) available`);
}

export function getMcpTools() {
  return cachedTools;
}

export function getMcpContextBlock() {
  return buildMcpContextBlock(
    config.mcp.servers,
    cachedTools,
    mcpClients.map((client) => client.name)
  );
}

/**
 * Fail-open wrapper around getMcpContextBlock().
 * Returns an empty string (rather than propagating an exception) when context
 * assembly fails unexpectedly, so prompt construction is never blocked by an
 * MCP runtime error.
 * @returns {string}
 */
export function safeGetMcpContextBlock() {
  try {
    return getMcpContextBlock();
  } catch (err) {
    logger.warn(`[mcp] getMcpContextBlock failed — falling back to empty context: ${err.message}`);
    return "";
  }
}

function extractUrlsFromText(text) {
  const matches = String(text ?? "").match(/https?:\/\/[^\s<>"'`}\]]+/gi);
  return matches ?? [];
}

function addHttpUrl(urls, value) {
  const trimmed = String(value ?? "").trim().replace(TRAILING_URL_PUNCTUATION_RE, "");
  if (!trimmed) return;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      urls.add(parsed.toString());
    }
  } catch {
    // ignore invalid URLs
  }
}

function extractUrlsFromObject(value, urls, depth = 0) {
  if (depth > MAX_URL_EXTRACTION_DEPTH || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) extractUrlsFromObject(item, urls, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && URL_FIELD_KEY_RE.test(key)) {
      addHttpUrl(urls, child);
      continue;
    }
    extractUrlsFromObject(child, urls, depth + 1);
  }
}

/**
 * @param {{content?: Array<any>, structuredContent?: any}} result
 * @returns {string[]}
 */
export function extractMcpSourceUrls(result) {
  const urls = new Set();
  const content = Array.isArray(result?.content) ? result.content : [];

  for (const item of content) {
    if (item?.type === "resource" && item.resource && typeof item.resource === "object") {
      addHttpUrl(urls, item.resource.uri);
      addHttpUrl(urls, item.resource.url);
      extractUrlsFromObject(item.resource, urls);
    }
    if (item?.type === "text" && typeof item.text === "string") {
      for (const url of extractUrlsFromText(item.text)) {
        addHttpUrl(urls, url);
      }
    }
  }

  extractUrlsFromObject(result?.structuredContent, urls);
  return [...urls];
}

function appendSourceLines(text, sources) {
  const baseText = typeof text === "string" ? text : "";
  if (!Array.isArray(sources) || sources.length === 0) {
    return baseText;
  }
  return `${baseText}\n\n${sources.map((url) => `Source: ${url}`).join("\n")}`.trim();
}

/**
 * @param {{content?: Array<any>, structuredContent?: any}} result
 * @returns {{ text: string, sources: string[] }}
 */
export function formatMcpToolResponse(result) {
  const text = (result?.content ?? [])
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "resource") return JSON.stringify(item.resource);
      return JSON.stringify(item);
    })
    .join("\n");
  const sources = extractMcpSourceUrls(result);
  return { text: appendSourceLines(text, sources), sources };
}

/**
 * @param {string} prefixedName
 * @param {object} args
 * @returns {Promise<{ text: string, sources: string[] }>}
 */
export async function callMcpTool(prefixedName, args) {
  const toolEntry = cachedTools.find((t) => t.function.name === prefixedName);
  if (!toolEntry) {
    throw new Error(`[mcp] Unknown tool: ${prefixedName}`);
  }

  const serverEntry = mcpClients.find((c) => c.name === toolEntry._serverName);
  if (!serverEntry) {
    throw new Error(`[mcp] No client for server: ${toolEntry._serverName}`);
  }

  logger.debug(
    `[mcp] Calling tool ${toolEntry._originalName} on ${toolEntry._serverName} args=${safeArgsPreview(args)}`
  );

  const result = await serverEntry.client.callTool({
    name: toolEntry._originalName,
    arguments: args,
  });
  const formatted = formatMcpToolResponse(result);
  logger.debug(
    `[mcp] Tool ${toolEntry._originalName} returned ${formatted.text.length} chars` +
    (formatted.sources.length > 0 ? ` (${formatted.sources.length} source url(s))` : "")
  );
  return formatted;
}

export async function shutdownMcp() {
  for (const { name, client } of mcpClients) {
    try {
      await client.close();
      logger.debug(`[mcp] Disconnected from ${name}`);
    } catch (err) {
      logger.warn(`[mcp] Error disconnecting from ${name}: ${err.message}`);
    }
  }
  mcpClients.length = 0;
  cachedTools.length = 0;
}
