import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_TOKEN = "test-token";
process.env.LOG_LEVEL = "warn";
process.env.LOCAL_AGENT_URL = "http://agent.test";
process.env.LOCAL_MODEL_FILE = "model.gguf";

function createResponse(ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    async text() {
      return ok ? "" : "failed";
    },
  };
}

async function loadAgentService() {
  return import(`../src/services/agentService.js?agent-service-test=${Date.now()}-${Math.random()}`);
}

describe("agentService local readiness", () => {
  test("marks the local model ready after a successful agent /start", async () => {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return createResponse(true);
    };

    try {
      const service = await loadAgentService();

      assert.equal(service.getLocalModelReady(), false);

      await service.ensureLocalModel();

      assert.equal(service.getActiveLocalModel(), "local");
      assert.equal(service.getLocalModelReady(), true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://agent.test/start");
      assert.deepEqual(JSON.parse(calls[0].options.body), {
        model: "model.gguf",
        role: "local",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("clears the ready flag again when the agent reconnects", async () => {
    const originalFetch = global.fetch;

    global.fetch = async () => createResponse(true);

    try {
      const service = await loadAgentService();

      await service.ensureLocalModel();
      assert.equal(service.getLocalModelReady(), true);

      service.resetActiveModelOnReconnect();

      assert.equal(service.getActiveLocalModel(), null);
      assert.equal(service.getLocalModelReady(), false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
