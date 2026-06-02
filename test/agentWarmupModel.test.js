import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { warmupModel } = await import("../agent/warmupModel.js");

function createLogger() {
  const entries = [];
  return {
    entries,
    info(message) {
      entries.push({ level: "info", message });
    },
    warn(message) {
      entries.push({ level: "warn", message });
    },
  };
}

describe("warmupModel()", () => {
  test("sends a minimal local chat completion warmup request", async () => {
    const logger = createLogger();
    const calls = [];

    await warmupModel(8081, {
      logger,
      async fetchImpl(url, options) {
        calls.push({ url, options });
        return {
          ok: true,
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:8081/v1/chat/completions");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers["Content-Type"], "application/json");

    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body, {
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
      stream: false,
    });
    assert.ok(
      logger.entries.some((entry) => entry.level === "info" && entry.message === "Model warmup complete")
    );
  });

  test("logs failures as non-fatal warnings", async () => {
    const logger = createLogger();

    await warmupModel(8081, {
      logger,
      async fetchImpl() {
        throw new Error("fetch failed");
      },
    });

    assert.ok(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message === "Model warmup failed (non-fatal): fetch failed"
      )
    );
  });
});
