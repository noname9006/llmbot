import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_ENV = { ...process.env };

async function loadMcpServiceFresh() {
  process.env = { ...ORIGINAL_ENV, DISCORD_TOKEN_REMOTE: "test-token" };
  return import(`../src/services/mcpService.js?mcp-context-test=${Date.now()}-${Math.random()}`);
}

after(() => {
  process.env = ORIGINAL_ENV;
});

describe("buildMcpContextBlock()", () => {
  test("returns empty string when no labeled connected server has tools", async () => {
    const { buildMcpContextBlock } = await loadMcpServiceFresh();
    const block = buildMcpContextBlock(
      [{ name: "gitbook-1", label: "Botanix" }],
      [],
      ["gitbook-1"]
    );
    assert.equal(block, "");
  });

  test("includes only labeled connected servers", async () => {
    const { buildMcpContextBlock } = await loadMcpServiceFresh();
    const block = buildMcpContextBlock(
      [
        { name: "gitbook-1", label: "Botanix" },
        { name: "coingecko", label: "crypto prices and market data" },
        { name: "custom", label: "" },
      ],
      [
        { _serverName: "gitbook-1", _originalName: "searchDocumentation" },
        { _serverName: "gitbook-1", _originalName: "getPage" },
        { _serverName: "coingecko", _originalName: "getPrice" },
      ],
      ["gitbook-1", "custom"]
    );

    assert.match(block, /## Available knowledge tools:/);
    assert.match(
      block,
      /- gitbook-1 \(Botanix\): use searchDocumentation, getPage for specific questions about Botanix/
    );
    assert.doesNotMatch(block, /coingecko/);
    assert.match(
      block,
      /Prefer these tools over guessing for specific factual questions about the topics above\./
    );
  });
});
