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
          if (toolName === "gitbook-2__searchDocumentation" && args.query === "stBTC staking peg") {
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
    const searchQueries = calls
      .filter((call) => call.toolName === "gitbook-2__searchDocumentation")
      .map((call) => call.args.query);
    assert.deepEqual(searchQueries, ["stBTC staking and peg mechanism", "stBTC staking peg"]);
    assert.ok(!searchQueries.includes("stBTC staking"));
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
    const seenMessages = [];

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
          seenMessages.push(messages.map((message) => ({ ...message })));
          if (round === 1) {
            assert.equal(availableTools.length, tools.length);
            assert.match(
              messages.at(-1).content,
              /function calling API — do not write 'call toolname' as text/i
            );
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
    assert.equal(seenMessages[0].at(-1).role, "user");
  });

  test("appends at most two missing Source lines", async () => {
    const tools = createDocsTools();
    let round = 0;

    const response = await llamaWithToolsInternal(
      "http://llama.test/v1",
      [{ role: "user", content: "Share docs" }],
      {},
      {
        mcpEnabled: true,
        getMcpTools: () => tools,
        logger: createLogger(),
        async callMcpTool() {
          return {
            ok: true,
            empty: false,
            data: { title: "stBTC docs" },
            error: null,
            tool: "gitbook-2__searchDocumentation",
            meta: {},
            sources: [
              "https://docs.example.com/source-1",
              "https://docs.example.com/source-2",
              "https://docs.example.com/source-3",
            ],
          };
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
                    arguments: JSON.stringify({ query: "stBTC docs" }),
                  },
                },
              ],
            };
          }
          return { content: "Here you go", tool_calls: null };
        },
      }
    );

    const sourceMatches = response.match(/^Source:\s.*$/gm) ?? [];
    assert.equal(sourceMatches.length, 2);
    assert.ok(response.includes("Source: https://docs.example.com/source-1"));
    assert.ok(response.includes("Source: https://docs.example.com/source-2"));
    assert.ok(!response.includes("Source: https://docs.example.com/source-3"));
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

  test("falls back to memory when a docs tool returns an execution error", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    let round = 0;
    const messages = [];

    const response = await llamaWithToolsInternal(
      "http://llama.test/v1",
      [{ role: "user", content: "what is stBTC?" }],
      {},
      {
        mcpEnabled: true,
        getMcpTools: () => tools,
        logger,
        async callMcpTool(toolName) {
          return {
            ok: false,
            empty: false,
            data: null,
            error: "execution_error: connection refused",
            tool: toolName,
            meta: {},
            sources: [],
          };
        },
        async llamaChatCompletion(baseUrl, msgs) {
          round += 1;
          messages.push(...msgs);
          if (round === 1) {
            return {
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  function: {
                    name: "gitbook-2__searchDocumentation",
                    arguments: JSON.stringify({ query: "stBTC" }),
                  },
                },
              ],
            };
          }
          return {
            content: "I couldn't reach the docs, but from memory: stBTC is a liquid staking token for Bitcoin.",
            tool_calls: null,
          };
        },
      }
    );

    assert.match(response, /stBTC is a liquid staking token/);
    assert.doesNotMatch(response, /I couldn't retrieve any documentation results/);
    assert.ok(
      logger.entries.some((e) => e.message.includes("docs tool execution error detected")),
      "expected an execution error log entry"
    );
    const fallbackMsg = messages.find(
      (m) => m.role === "user" && m.content?.includes("documentation tool is currently unavailable")
    );
    assert.ok(fallbackMsg, "expected a fallback instruction to be injected into messages");
  });

  test("falls back to memory when callMcpTool throws (server disconnected)", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    let round = 0;
    const messages = [];

    const response = await llamaWithToolsInternal(
      "http://llama.test/v1",
      [{ role: "user", content: "how does Botanix work?" }],
      {},
      {
        mcpEnabled: true,
        getMcpTools: () => tools,
        logger,
        async callMcpTool() {
          throw new Error("[mcp] No client for server: gitbook-1");
        },
        async llamaChatCompletion(baseUrl, msgs) {
          round += 1;
          messages.push(...msgs);
          if (round === 1) {
            return {
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  function: {
                    name: "gitbook-1__searchDocumentation",
                    arguments: JSON.stringify({ query: "Botanix" }),
                  },
                },
              ],
            };
          }
          return {
            content: "Docs unavailable, but from memory: Botanix is Bitcoin DeFi.",
            tool_calls: null,
          };
        },
      }
    );

    assert.match(response, /Botanix is Bitcoin DeFi/);
    assert.doesNotMatch(response, /I couldn't retrieve any documentation results/);
    const fallbackMsg = messages.find(
      (m) => m.role === "user" && m.content?.includes("documentation tool is currently unavailable")
    );
    assert.ok(fallbackMsg, "expected a fallback instruction to be injected into messages");
  });

  test("retries when the model leaks malformed tool-call text instead of structured tool_calls", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    const calls = [];
    const rounds = [];
    let round = 0;

    const response = await llamaWithToolsInternal(
      "http://llama.test/v1",
      [{ role: "user", content: "what is stBTC?" }],
      {},
      {
        mcpEnabled: true,
        getMcpTools: () => tools,
        logger,
        async callMcpTool(toolName) {
          calls.push(toolName);
          return {
            ok: true,
            empty: false,
            data: {
              title: "stBTC",
              snippet: "stBTC is a Bitcoin liquid staking token.",
              url: "https://docs.example.com/stbtc",
            },
            error: null,
            tool: toolName,
            meta: {},
            sources: ["https://docs.example.com/stbtc"],
          };
        },
        async llamaChatCompletion(baseUrl, messages) {
          round += 1;
          rounds.push(messages.map((message) => ({ ...message })));
          if (round === 1) {
            return {
              content: 'call gitbook-1__searchDocumentation{query:"stBTC"}<tool_call|>',
              tool_calls: null,
            };
          }
          if (round === 2) {
            const reminder = messages.findLast(
              (message) => message.role === "user" && /Please make a proper tool call now/i.test(message.content ?? "")
            );
            assert.ok(reminder, "expected malformed tool call retry reminder");
            return {
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  function: {
                    name: "gitbook-1__searchDocumentation",
                    arguments: JSON.stringify({ query: "stBTC" }),
                  },
                },
              ],
            };
          }
          return {
            content: "stBTC is a Bitcoin liquid staking token.",
            tool_calls: null,
          };
        },
      }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0], "gitbook-1__searchDocumentation");
    assert.match(response, /stBTC is a Bitcoin liquid staking token/);
    assert.ok(
      logger.entries.some((entry) => entry.message.includes("detected malformed tool call syntax")),
      "expected malformed tool call warning"
    );
    assert.match(rounds[0].at(-1).content, /function calling API/i);
  });
});
