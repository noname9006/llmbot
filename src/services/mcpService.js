/**
 * MCP client service — connects to remote MCP servers (CoinGecko, GitBook, …)
 * and exposes their tools to the LLM via OpenAI tool-calling format.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/** @type {Array<{ name: string, client: Client, toolNames: Set<string> }>} */
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

  logger.info(`[mcp] Connecting to ${serverName} (${url}) via ${transport}…`);
  await client.connect(transportInstance);
  logger.info(`[mcp] Connected to ${serverName}`);

  const { tools } = await client.listTools();
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

  mcpClients.push({ name: serverName, client, toolNames });
  cachedTools.push(...prefixedTools);
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

  logger.debug(`[mcp] Calling tool ${toolEntry._originalName} on ${toolEntry._serverName} args=${JSON.stringify(args)}`);

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
      logger.debug(`[mcp] Error disconnecting from ${name}: ${err.message}`);
    }
  }
  mcpClients.length = 0;
  cachedTools = [];
}
