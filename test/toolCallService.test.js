import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_TOKEN_REMOTE = "test-token";

const { executeToolCallWithFallback, llamaWithToolsInternal } = await import(
  `../src/services/toolCallService.js?tool-call-test=${Date.now()}-${Math.random()}`
);

function createLogger() {
  const entries = [];
  return {
    entries,
    debug(message) {
      entries.push({ level: "debug", message });
    },
    warn(message) {
      entries.push({ level: "warn", message });
    },
    info() {},
    error() {},
    timer() {
      return () => 0;
    },
  };
}

function createDocsTools() {
  return [
    {
      _serverName: "gitbook-2",
      _originalName: "searchDocumentation",
      function: {
        name: "gitbook-2__searchDocumentation",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    },
    {
      _serverName: "gitbook-2",
      _originalName: "getPage",
      function: {
        name: "gitbook-2__getPage",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
    {
      _serverName: "gitbook-1",
      _originalName: "searchDocumentation",
      function: {
        name: "gitbook-1__searchDocumentation",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    },
  ];
}

describe("executeToolCallWithFallback()", () => {
  test("retries docs search with simplified queries and fetches a concrete page", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    const calls = [];
    const result = await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "stBTC staking and peg mechanism" },
      {
        tools,
        logger,
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          if (toolName === "gitbook-2__searchDocumentation" && args.query === "stBTC staking") {
            return {
              ok: true,
              empty: false,
              data: {
                hits: [
                  {
                    title: "stBTC staking",
                    path: "/stbtc/staking",
                    url: "https://docs.example.com/stbtc/staking",
                  },
                ],
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/stbtc/staking"],
            };
          }
          if (toolName === "gitbook-2__searchDocumentation") {
            return { ok: true, empty: true, data: null, error: null, tool: toolName, meta: {}, sources: [] };
          }
          if (toolName === "gitbook-2__getPage") {
            return {
              ok: true,
              empty: false,
              data: {
                title: "stBTC staking",
                content: "stBTC staking docs content",
                url: "https://docs.example.com/stbtc/staking",
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/stbtc/staking"],
            };
          }
          throw new Error(`Unexpected tool call: ${toolName} ${JSON.stringify(args)}`);
        },
      }
    );

    assert.equal(calls[0].args.query, "stBTC staking and peg mechanism");
    assert.ok(calls.some((call) => call.args.query === "stBTC staking"));
    assert.equal(calls.at(-1).toolName, "gitbook-2__getPage");
    assert.equal(result.grounded, true);
    assert.equal(result.result.tool, "gitbook-2__getPage");
    assert.ok(
      logger.entries.some((entry) => entry.message.includes("docs-fallback")),
      "expected a fallback log entry"
    );
  });

  test("surfaces parser errors and still attempts fallback", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    const calls = [];
    const result = await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "stBTC staking" },
      {
        tools,
        logger,
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          if (toolName === "gitbook-2__searchDocumentation") {
            return {
              ok: false,
              empty: false,
              data: null,
              error: "parse_error: invalid MCP payload",
              tool: toolName,
              meta: {},
              sources: [],
            };
          }
          if (toolName === "gitbook-1__searchDocumentation") {
            return { ok: true, empty: true, data: null, error: null, tool: toolName, meta: {}, sources: [] };
          }
          throw new Error(`Unexpected tool call: ${toolName} ${JSON.stringify(args)}`);
        },
      }
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[1].toolName, "gitbook-1__searchDocumentation");
    assert.equal(result.result.ok, false);
    assert.match(result.result.error ?? "", /^parse_error:/);
    assert.equal(result.result.meta.attempts[0].error, "parse_error: invalid MCP payload");
  });
});

describe("llamaWithToolsInternal()", () => {
  test("allows grounded summaries when a non-empty docs result is returned", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    let round = 0;

    const response = await llamaWithToolsInternal(
      "http://llama.test/v1",
      [{ role: "user", content: "Share the stBTC staking docs" }],
      {},
      {
        mcpEnabled: true,
        getMcpTools: () => tools,
        logger,
        async callMcpTool() {
          return {
            ok: true,
            empty: false,
            data: {
              title: "stBTC staking",
              snippet: "How staking works",
              url: "https://docs.example.com/stbtc/staking",
            },
            error: null,
            tool: "gitbook-2__searchDocumentation",
            meta: {},
            sources: ["https://docs.example.com/stbtc/staking"],
          };
        },
        async llamaChatCompletion(baseUrl, messages, opts, availableTools) {
          round += 1;
          if (round === 1) {
            assert.equal(availableTools.length, tools.length);
            return {
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  function: {
                    name: "gitbook-2__searchDocumentation",
                    arguments: JSON.stringify({ query: "stBTC staking" }),
                  },
                },
              ],
            };
          }

          const toolMessage = messages[messages.length - 1];
          const envelope = JSON.parse(toolMessage.content);
          assert.equal(envelope.ok, true);
          assert.equal(envelope.empty, false);
          assert.equal(envelope.data.title, "stBTC staking");
          return {
            content: "I found the stBTC staking docs.\nSource: https://docs.example.com/stbtc/staking",
            tool_calls: null,
          };
        },
      }
    );

    assert.match(response, /I found the stBTC staking docs/);
    assert.match(response, /Source: https:\/\/docs\.example\.com\/stbtc\/staking/);
  });

  test("returns an explicit no-results response when all docs fallbacks are empty", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    let round = 0;

    const response = await llamaWithToolsInternal(
      "http://llama.test/v1",
      [{ role: "user", content: "Could you share the stBTC staking docs link?" }],
      {},
      {
        mcpEnabled: true,
        getMcpTools: () => tools,
        logger,
        async callMcpTool(toolName) {
          return { ok: true, empty: true, data: null, error: null, tool: toolName, meta: {}, sources: [] };
        },
        async llamaChatCompletion() {
          round += 1;
          if (round === 1) {
            return {
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  function: {
                    name: "gitbook-2__searchDocumentation",
                    arguments: JSON.stringify({ query: "stBTC staking and peg mechanism" }),
                  },
                },
              ],
            };
          }
          return { content: "I found a few hits but no direct link.", tool_calls: null };
        },
      }
    );

    assert.match(response, /I couldn't retrieve any documentation results/);
    assert.doesNotMatch(response, /I found/i);
    assert.ok(
      logger.entries.some((entry) => entry.message.includes("docs-fallback")),
      "expected fallback logging after an empty docs result"
    );
  });

  test("matches the production incident path without fabricating a found-docs answer", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    const calls = [];
    let round = 0;

    const response = await llamaWithToolsInternal(
      "http://llama.test/v1",
      [{ role: "user", content: "Share the stBTC docs link" }],
      {},
      {
        mcpEnabled: true,
        getMcpTools: () => tools,
        logger,
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          return { ok: true, empty: true, data: null, error: null, tool: toolName, meta: {}, sources: [] };
        },
        async llamaChatCompletion() {
          round += 1;
          if (round === 1) {
            return {
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  function: {
                    name: "gitbook-2__searchDocumentation",
                    arguments: JSON.stringify({ query: "stBTC staking" }),
                  },
                },
              ],
            };
          }
          return { content: "I found a few hits about stBTC staking.", tool_calls: null };
        },
      }
    );

    assert.match(response, /I couldn't retrieve any documentation results/);
    assert.equal(calls[0].toolName, "gitbook-2__searchDocumentation");
    assert.ok(calls.some((call) => call.toolName === "gitbook-1__searchDocumentation"));
  });
});
