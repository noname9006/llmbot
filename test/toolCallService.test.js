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

function createDocsSearchOnlyTools() {
  return createDocsTools().filter((tool) => tool.function.name !== "gitbook-2__getPage");
}

describe("executeToolCallWithFallback()", () => {
  test("keeps bare 'what is' docs queries unchanged", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    const calls = [];
    await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "what is dolomite" },
      {
        tools,
        logger,
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          if (toolName === "gitbook-2__searchDocumentation" && args.query === "what is dolomite") {
            return {
              ok: true,
              empty: false,
              data: {
                hits: [{ title: "Dolomite Introduction", path: "/introduction", url: "https://docs.example.com/introduction" }],
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/introduction"],
            };
          }
          if (toolName === "gitbook-2__getPage") {
            return {
              ok: true,
              empty: false,
              data: {
                title: "Dolomite Introduction",
                content: "Dolomite docs content",
                url: "https://docs.example.com/introduction",
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/introduction"],
            };
          }
          throw new Error(`Unexpected tool call: ${toolName} ${JSON.stringify(args)}`);
        },
      }
    );

    const searchQueries = calls
      .filter((call) => call.toolName === "gitbook-2__searchDocumentation")
      .map((call) => call.args.query);
    assert.deepEqual(searchQueries, ["what is dolomite"]);
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("[tool-call] executeToolCallWithFallback tool=gitbook-2__searchDocumentation isDocsSearch=true")
      ),
      "expected executeToolCallWithFallback entry log"
    );
    assert.ok(
      logger.entries.some((entry) => entry.message.includes('[tool-call] query variants: ["what is dolomite"')),
      "expected query variants log"
    );
    assert.ok(
      logger.entries.some((entry) => entry.message.includes("[tool-call] search tool candidates (2):")),
      "expected search tool candidates log"
    );
    assert.ok(
      logger.entries.some((entry) => entry.message.includes("[tool-call] maybeFetchDocsPage: 1 ranked page candidates")),
      "expected maybeFetchDocsPage candidate count log"
    );
    assert.ok(
      logger.entries.some((entry) => entry.message.includes("[tool-call] getPage succeeded — canonicalUrl=https://docs.example.com/introduction")),
      "expected getPage success log"
    );
  });

  test("keeps 'tell me about' docs queries unchanged", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    const calls = [];
    await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "tell me about dolomite" },
      {
        tools,
        logger,
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          if (toolName === "gitbook-2__searchDocumentation" && args.query === "tell me about dolomite") {
            return {
              ok: true,
              empty: false,
              data: {
                hits: [{ title: "Dolomite Introduction", path: "/introduction", url: "https://docs.example.com/introduction" }],
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/introduction"],
            };
          }
          if (toolName === "gitbook-2__getPage") {
            return {
              ok: true,
              empty: false,
              data: {
                title: "Dolomite Introduction",
                content: "Dolomite docs content",
                url: "https://docs.example.com/introduction",
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/introduction"],
            };
          }
          throw new Error(`Unexpected tool call: ${toolName} ${JSON.stringify(args)}`);
        },
      }
    );

    const searchQueries = calls
      .filter((call) => call.toolName === "gitbook-2__searchDocumentation")
      .map((call) => call.args.query);
    assert.deepEqual(searchQueries, ["tell me about dolomite"]);
  });

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

  test("trims fallback search result collection arrays to top 2 when getPage fails", async () => {
    const logger = createLogger();
    const result = await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "what is dolomite" },
      {
        tools: createDocsTools(),
        logger,
        async callMcpTool(toolName) {
          if (toolName === "gitbook-2__searchDocumentation") {
            return {
              ok: true,
              empty: false,
              data: {
                hits: [
                  { url: "https://docs.example.com/introduction" },
                  { url: "https://docs.example.com/overview" },
                  { url: "https://docs.example.com/campaigns/level-4" },
                ],
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: [
                "https://docs.example.com/introduction",
                "https://docs.example.com/overview",
                "https://docs.example.com/campaigns/level-4",
              ],
            };
          }
          if (toolName === "gitbook-2__getPage") {
            return { ok: true, empty: true, data: null, error: null, tool: toolName, meta: {}, sources: [] };
          }
          throw new Error(`Unexpected tool call: ${toolName}`);
        },
      }
    );

    assert.equal(result.result.tool, "gitbook-2__searchDocumentation");
    assert.equal(result.result.data.hits.length, 2);
    assert.deepEqual(
      result.result.data.hits.map((hit) => hit.url),
      ["https://docs.example.com/introduction", "https://docs.example.com/overview"]
    );
    assert.deepEqual(result.result.sources, [
      "https://docs.example.com/introduction",
      "https://docs.example.com/overview",
      "https://docs.example.com/campaigns/level-4",
    ]);
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("[tool-call] getPage unavailable or failed — using trimmed search result (fallback path)")
      ),
      "expected fallback-path log"
    );
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("[tool-call] trimSearchResultData: maxItems=2 data shape=object changed=true")
      ),
      "expected trimSearchResultData log"
    );
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes('[tool-call] extractTopRankedSourceUrls: picked 1 url(s): ["https://docs.example.com/introduction"]')
      ),
      "expected extractTopRankedSourceUrls log"
    );
  });

  test("tries homepage getPage fallback when search yields no page candidates", async () => {
    const logger = createLogger();
    const calls = [];
    const result = await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "what is dolomite" },
      {
        tools: createDocsTools(),
        logger,
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          if (toolName === "gitbook-2__searchDocumentation") {
            return {
              ok: true,
              empty: false,
              data: { hits: [{ title: "Dolomite docs" }, { title: "Overview" }] },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com"],
            };
          }
          if (toolName === "gitbook-2__getPage" && args.path === "index") {
            return {
              ok: true,
              empty: false,
              data: { title: "Docs Home", content: "Welcome" },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com"],
            };
          }
          throw new Error(`Unexpected tool call: ${toolName} ${JSON.stringify(args)}`);
        },
      }
    );

    assert.deepEqual(
      calls.map((call) => ({ toolName: call.toolName, args: call.args })),
      [
        { toolName: "gitbook-2__searchDocumentation", args: { query: "what is dolomite" } },
        { toolName: "gitbook-2__getPage", args: { path: "index" } },
      ]
    );
    assert.equal(result.result.tool, "gitbook-2__getPage");
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("[tool-call] maybeFetchDocsPage: 0 unique page candidates from search result")
      ),
      "expected zero-candidate log"
    );
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("[tool-call] maybeFetchDocsPage: no valid page candidates — trying homepage fallback")
      ),
      "expected homepage fallback log"
    );
    assert.ok(
      logger.entries.some(
        (entry) =>
          entry.message.includes('"strategy":"getPage-homepage"') &&
          entry.message.includes('"path":"index"')
      ),
      "expected homepage docs-fallback log"
    );
  });

  test("extracts page candidates from text-format search results via Link: lines", async () => {
    const logger = createLogger();
    const calls = [];
    const result = await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "plutusdao plvglp" },
      {
        tools: createDocsTools(),
        logger,
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          if (toolName === "gitbook-2__searchDocumentation") {
            return {
              ok: true,
              empty: false,
              data: {
                content: [
                  {
                    text:
                      "Title: PlutusDAO - plvGLP\n" +
                      "Link: https://docs.example.com/integrations/partner-vault\n" +
                      "Content: Example protocol integration docs",
                  },
                ],
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/integrations/partner-vault"],
            };
          }
          if (toolName === "gitbook-2__getPage") {
            assert.deepEqual(args, { path: "https://docs.example.com/integrations/partner-vault" });
            return {
              ok: true,
              empty: false,
              data: { title: "Partner vault", content: "Docs page content" },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/integrations/partner-vault"],
            };
          }
          throw new Error(`Unexpected tool call: ${toolName} ${JSON.stringify(args)}`);
        },
      }
    );

    assert.equal(calls[1].toolName, "gitbook-2__getPage");
    assert.equal(result.result.tool, "gitbook-2__getPage");
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("[tool-call] maybeFetchDocsPage: 1 ranked page candidates")
      ),
      "expected non-zero candidate log"
    );
  });

  test("ranks homepage-like page above integration for broad what-is queries", async () => {
    const logger = createLogger();
    const calls = [];
    const searchText =
      "Title: Partner integration\n" +
      "Link: https://docs.example.com/integrations/partner-vault\n" +
      "Content: Example protocol integration with partner vaults\n\n" +
      "Title: Example Protocol\n" +
      "Link: https://docs.example.com/\n" +
      "Content: Example combines lending and trading in one platform\n";

    await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "what is example" },
      {
        tools: createDocsTools(),
        logger,
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          if (toolName === "gitbook-2__searchDocumentation") {
            return {
              ok: true,
              empty: false,
              data: { content: [{ type: "text", text: searchText }] },
              error: null,
              tool: toolName,
              meta: {},
              sources: [
                "https://docs.example.com/integrations/partner-vault",
                "https://docs.example.com/",
              ],
            };
          }
          if (toolName === "gitbook-2__getPage") {
            assert.equal(args.path, "https://docs.example.com/");
            return {
              ok: true,
              empty: false,
              data: { title: "Example Protocol", content: "Overview page" },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/"],
            };
          }
          throw new Error(`Unexpected tool call: ${toolName} ${JSON.stringify(args)}`);
        },
      }
    );

    assert.equal(calls[1].toolName, "gitbook-2__getPage");
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("ranked page candidates") &&
        entry.message.includes("docs.example.com/") &&
        entry.message.includes("partner-vault")
      ),
      "expected ranked candidates log with both URLs"
    );
  });

  test("ranks index slug homepage above deep pages for broad queries", async () => {
    const calls = [];
    const searchText =
      "Title: Campaign level 4\n" +
      "Link: https://docs.example.com/campaigns/level-4\n" +
      "Content: Campaign mechanics\n\n" +
      "Title: Docs Home\n" +
      "Link: https://docs.example.com/index\n" +
      "Content: Welcome to the protocol overview\n";

    await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "what is example" },
      {
        tools: createDocsTools(),
        logger: createLogger(),
        async callMcpTool(toolName, args) {
          calls.push({ toolName, args });
          if (toolName === "gitbook-2__searchDocumentation") {
            return {
              ok: true,
              empty: false,
              data: { content: [{ type: "text", text: searchText }] },
              error: null,
              tool: toolName,
              meta: {},
              sources: [],
            };
          }
          if (toolName === "gitbook-2__getPage") {
            assert.equal(args.path, "https://docs.example.com/index");
            return {
              ok: true,
              empty: false,
              data: { title: "Docs Home", content: "Overview" },
              error: null,
              tool: toolName,
              meta: {},
              sources: ["https://docs.example.com/index"],
            };
          }
          throw new Error(`Unexpected tool call: ${toolName}`);
        },
      }
    );

    assert.equal(calls[1].toolName, "gitbook-2__getPage");
  });

  test("trims fallback GitBook content arrays to top 2 when getPage is unavailable", async () => {
    const result = await executeToolCallWithFallback(
      "gitbook-2__searchDocumentation",
      { query: "what is dolomite" },
      {
        tools: createDocsSearchOnlyTools(),
        logger: createLogger(),
        async callMcpTool(toolName) {
          if (toolName === "gitbook-2__searchDocumentation") {
            return {
              ok: true,
              empty: false,
              data: {
                content: [
                  { type: "text", text: "Result 1" },
                  { type: "text", text: "Result 2" },
                  { type: "text", text: "Result 3" },
                ],
              },
              error: null,
              tool: toolName,
              meta: {},
              sources: [],
            };
          }
          throw new Error(`Unexpected tool call: ${toolName}`);
        },
      }
    );

    assert.equal(result.result.data.content.length, 2);
    assert.deepEqual(
      result.result.data.content.map((entry) => entry.text),
      ["Result 1", "Result 2"]
    );
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
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("[tool-call] llamaWithTools url=http://llama.test/v1 mcpEnabled=true tools=3")
      ),
      "expected llamaWithTools startup log"
    );
    assert.ok(
      logger.entries.some((entry) =>
        entry.message.includes("[tool-call] collected sourceUrl: https://docs.example.com/stbtc/staking")
      ),
      "expected collected sourceUrl log"
    );
  });

  test("appends the top-ranked source URL from extracted search sources", async () => {
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
        async callMcpTool(toolName) {
          if (toolName === "gitbook-2__searchDocumentation") {
            return {
              ok: true,
              empty: false,
              data: { hits: [{ title: "stBTC page 1" }, { title: "stBTC page 2" }] },
              error: null,
              tool: toolName,
              meta: {},
              sources: [
                "https://docs.example.com/source-1",
                "https://docs.example.com/source-2",
              ],
            };
          }
          // getPage returns empty so we fall back to search result
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
    assert.equal(sourceMatches.length, 1);
    assert.ok(response.includes("Source: https://docs.example.com/source-1"));
    assert.ok(!response.includes("Source: https://docs.example.com/source-2"));
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

  test("injects format reminder on follow-up turns with more than 2 messages in context", async () => {
    const logger = createLogger();
    const tools = createDocsTools();
    const capturedMessages = [];

    await llamaWithToolsInternal(
      "http://llama.test/v1",
      [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "what is dolomite" },
        { role: "assistant", content: "Dolomite is a DeFi protocol." },
        { role: "user", content: "how does it work exactly?" },
      ],
      {},
      {
        mcpEnabled: true,
        getMcpTools: () => tools,
        logger,
        async callMcpTool(toolName) {
          return {
            ok: true,
            empty: false,
            data: { title: "Dolomite", snippet: "Dolomite lending mechanics.", url: "https://docs.example.com/dolomite" },
            error: null,
            tool: toolName,
            meta: {},
            sources: ["https://docs.example.com/dolomite"],
          };
        },
        async llamaChatCompletion(baseUrl, messages) {
          capturedMessages.push(...messages);
          return {
            content: "Dolomite works as a lending protocol.",
            tool_calls: null,
          };
        },
      }
    );

    const lastUserMsg = capturedMessages.filter((m) => m.role === "user").at(-1);
    assert.ok(lastUserMsg, "expected a user message in captured messages");
    assert.match(
      lastUserMsg.content,
      /function calling API/i,
      "format reminder should be injected into the last user message even in multi-turn conversations"
    );
  });
});
