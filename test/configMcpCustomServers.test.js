import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  process.env.DISCORD_TOKEN_REMOTE = "test-token";
  process.env.MCP_ENABLED = "true";
}

async function loadConfigFresh() {
  return import(`../src/config.js?mcp-custom-test=${Date.now()}-${Math.random()}`);
}

describe("config.mcp custom server building", () => {
  beforeEach(() => {
    resetEnv();
  });

  after(() => {
    process.env = ORIGINAL_ENV;
  });

  test("supports MCP_SERVER_N_LABEL", async () => {
    process.env.MCP_SERVER_1_NAME = "docs";
    process.env.MCP_SERVER_1_URL = "https://example.com/mcp";
    process.env.MCP_SERVER_1_LABEL = "internal docs";
    const { config } = await loadConfigFresh();
    assert.equal(config.mcp.servers.length, 1);
    assert.equal(config.mcp.servers[0].label, "internal docs");
  });
});
