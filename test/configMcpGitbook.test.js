import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  process.env.DISCORD_TOKEN_REMOTE = "test-token";
  process.env.MCP_ENABLED = "true";
  process.env.MCP_GITBOOK_ENABLED = "true";
}

async function loadConfigFresh() {
  return import(`../src/config.js?mcp-gitbook-test=${Date.now()}-${Math.random()}`);
}

describe("config.mcp GitBook server building", () => {
  beforeEach(() => {
    resetEnv();
  });

  after(() => {
    process.env = ORIGINAL_ENV;
  });

  test("legacy MCP_GITBOOK_URL is supported and normalized to gitbook-1", async () => {
    process.env.MCP_GITBOOK_URL = "https://docs.example.com/my-space/";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers.length, 1);
    assert.equal(config.mcp.servers[0].name, "gitbook-1");
    assert.equal(config.mcp.servers[0].url, "https://docs.example.com/my-space/~gitbook/mcp");
  });

  test("numbered GitBook URLs build multiple gitbook-N servers", async () => {
    process.env.MCP_GITBOOK_URL_1 = "https://docs.botanixlabs.com/botanix/";
    process.env.MCP_GITBOOK_URL_2 = "https://docs.example.com/my-project/";
    process.env.MCP_GITBOOK_LABEL_1 = "Botanix";
    const { config } = await loadConfigFresh();

    assert.equal(config.mcp.servers.length, 2);
    assert.deepEqual(
      config.mcp.servers.map((s) => s.name),
      ["gitbook-1", "gitbook-2"]
    );
    assert.deepEqual(
      config.mcp.servers.map((s) => s.url),
      [
        "https://docs.botanixlabs.com/botanix/~gitbook/mcp",
        "https://docs.example.com/my-project/~gitbook/mcp",
      ]
    );
    assert.deepEqual(
      config.mcp.servers.map((s) => s.label),
      ["Botanix", ""]
    );
  });

  test("does not append suffix when GitBook URL already points to MCP endpoint", async () => {
    process.env.MCP_GITBOOK_URL_1 = "https://docs.example.com/project/~gitbook/mcp";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers[0].url, "https://docs.example.com/project/~gitbook/mcp");
  });

  test("appends MCP path before query/hash segments", async () => {
    process.env.MCP_GITBOOK_URL_1 = "https://docs.example.com/project/?tab=api#section";
    const { config } = await loadConfigFresh();
    assert.equal(
      config.mcp.servers[0].url,
      "https://docs.example.com/project/~gitbook/mcp?tab=api#section"
    );
  });

  test("uses per-instance token when present, otherwise shared MCP_GITBOOK_TOKEN", async () => {
    process.env.MCP_GITBOOK_URL_1 = "https://docs.one.example/";
    process.env.MCP_GITBOOK_URL_2 = "https://docs.two.example/";
    process.env.MCP_GITBOOK_TOKEN = "shared-token";
    process.env.MCP_GITBOOK_TOKEN_2 = "token-two";
    const { config } = await loadConfigFresh();

    assert.equal(config.mcp.servers[0].headers.Authorization, "Bearer shared-token");
    assert.equal(config.mcp.servers[1].headers.Authorization, "Bearer token-two");
  });

  test("legacy MCP_GITBOOK_URL uses MCP_GITBOOK_LABEL_1", async () => {
    process.env.MCP_GITBOOK_URL = "https://docs.example.com/my-space/";
    process.env.MCP_GITBOOK_LABEL_1 = "Project Docs";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers[0].label, "Project Docs");
  });
});
