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
    const list = toolNamesByServer.get(tool._serverName) ?? [];
    if (!list.includes(tool._originalName)) {
      list.push(tool._originalName);
      toolNamesByServer.set(tool._serverName, list);
    }
  }

  const lines = servers
    .filter((server) => connectedSet.has(server.name))
    .map((server) => ({
      name: server.name,
      label: String(server.label ?? "").trim(),
      tools: toolNamesByServer.get(server.name) ?? [],
    }))
    .filter((server) => server.label && server.tools.length > 0)
    .map(
      (server) =>
        `- ${server.name} (${server.label}): use ${server.tools.join(", ")} for specific questions about this topic`
    );

  if (lines.length === 0) return "";

  return (
    "## Available knowledge tools:\n" +
    `${lines.join("\n")}\n` +
    "Prefer these tools over guessing for specific factual questions about the topics above."
  );
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
 * @param {string} prefixedName
 * @param {object} args
 * @returns {Promise<string>}
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

  const text = (result.content ?? [])
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "resource") return JSON.stringify(item.resource);
      return JSON.stringify(item);
    })
    .join("\n");

  logger.debug(`[mcp] Tool ${toolEntry._originalName} returned ${text.length} chars`);
  return text;
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
