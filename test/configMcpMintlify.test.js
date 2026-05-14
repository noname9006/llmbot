import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  process.env.DISCORD_TOKEN_REMOTE = "test-token";
  process.env.MCP_ENABLED = "true";
  process.env.MCP_MINTLIFY_ENABLED = "true";
}

async function loadConfigFresh() {
  return import(`../src/config.js?mcp-mintlify-test=${Date.now()}-${Math.random()}`);
}

describe("config.mcp Mintlify server building", () => {
  beforeEach(() => {
    resetEnv();
  });

  after(() => {
    process.env = ORIGINAL_ENV;
  });

  test("legacy MCP_MINTLIFY_URL is supported and normalized to mintlify-1", async () => {
    process.env.MCP_MINTLIFY_URL = "https://docs.example.com/my-space/";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers.length, 1);
    assert.equal(config.mcp.servers[0].name, "mintlify-1");
    assert.equal(config.mcp.servers[0].url, "https://docs.example.com/my-space/~mcp");
  });

  test("numbered Mintlify URLs build multiple mintlify-N servers", async () => {
    process.env.MCP_MINTLIFY_URL_1 = "https://docs.botanixlabs.com/";
    process.env.MCP_MINTLIFY_URL_2 = "https://docs.example.com/my-project/";
    process.env.MCP_MINTLIFY_LABEL_1 = "Botanix";
    const { config } = await loadConfigFresh();

    assert.equal(config.mcp.servers.length, 2);
    assert.deepEqual(
      config.mcp.servers.map((s) => s.name),
      ["mintlify-1", "mintlify-2"]
    );
    assert.deepEqual(
      config.mcp.servers.map((s) => s.url),
      [
        "https://docs.botanixlabs.com/~mcp",
        "https://docs.example.com/my-project/~mcp",
      ]
    );
    assert.deepEqual(
      config.mcp.servers.map((s) => s.label),
      ["Botanix", ""]
    );
  });

  test("does not append suffix when Mintlify URL already points to MCP endpoint", async () => {
    process.env.MCP_MINTLIFY_URL_1 = "https://docs.example.com/project/~mcp";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers[0].url, "https://docs.example.com/project/~mcp");
  });

  test("appends MCP path before query/hash segments", async () => {
    process.env.MCP_MINTLIFY_URL_1 = "https://docs.example.com/project/?tab=api#section";
    const { config } = await loadConfigFresh();
    assert.equal(
      config.mcp.servers[0].url,
      "https://docs.example.com/project/~mcp?tab=api#section"
    );
  });

  test("uses per-instance token when present, otherwise shared MCP_MINTLIFY_TOKEN", async () => {
    process.env.MCP_MINTLIFY_URL_1 = "https://docs.one.example/";
    process.env.MCP_MINTLIFY_URL_2 = "https://docs.two.example/";
    process.env.MCP_MINTLIFY_TOKEN = "shared-token";
    process.env.MCP_MINTLIFY_TOKEN_2 = "token-two";
    const { config } = await loadConfigFresh();

    assert.equal(config.mcp.servers[0].headers.Authorization, "Bearer shared-token");
    assert.equal(config.mcp.servers[1].headers.Authorization, "Bearer token-two");
  });

  test("legacy MCP_MINTLIFY_URL uses MCP_MINTLIFY_LABEL_1", async () => {
    process.env.MCP_MINTLIFY_URL = "https://docs.example.com/my-space/";
    process.env.MCP_MINTLIFY_LABEL_1 = "Project Docs";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers[0].label, "Project Docs");
  });

  test("throws when enabled but no Mintlify URLs are configured", async () => {
    await assert.rejects(
      loadConfigFresh(),
      /MCP_MINTLIFY_ENABLED=true requires MCP_MINTLIFY_URL_1\.\.10 or legacy MCP_MINTLIFY_URL to be set\./
    );
  });
});
