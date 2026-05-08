import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  process.env.DISCORD_TOKEN_REMOTE = "test-token";
  process.env.MCP_ENABLED = "true";
  process.env.MCP_COINGECKO_ENABLED = "true";
}

async function loadConfigFresh() {
  return import(`../src/config.js?mcp-coingecko-test=${Date.now()}-${Math.random()}`);
}

describe("config.mcp CoinGecko server building", () => {
  beforeEach(() => {
    resetEnv();
  });

  after(() => {
    process.env = ORIGINAL_ENV;
  });

  test("uses default CoinGecko URL when MCP_COINGECKO_URL is not set", async () => {
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers.length, 1);
    assert.equal(config.mcp.servers[0].name, "coingecko");
    assert.equal(config.mcp.servers[0].url, "https://mcp.api.coingecko.com/");
  });

  test("uses custom URL when MCP_COINGECKO_URL is set", async () => {
    process.env.MCP_COINGECKO_URL = "https://custom-endpoint.example.com/";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers[0].url, "https://custom-endpoint.example.com/");
  });

  test("trims whitespace from MCP_COINGECKO_URL", async () => {
    process.env.MCP_COINGECKO_URL = "  https://custom-endpoint.example.com/  ";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers[0].url, "https://custom-endpoint.example.com/");
  });

  test("does not set headers when MCP_COINGECKO_API_KEY is empty", async () => {
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers[0].headers, undefined);
  });

  test("sets x-cg-pro-api-key header when MCP_COINGECKO_API_KEY is provided", async () => {
    process.env.MCP_COINGECKO_API_KEY = "my-pro-key";
    const { config } = await loadConfigFresh();
    assert.deepEqual(config.mcp.servers[0].headers, { "x-cg-pro-api-key": "my-pro-key" });
  });
});
