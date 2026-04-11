import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// Set required env vars BEFORE any module that transitively loads config.js
process.env.DISCORD_TOKEN = "test-token";
process.env.LOG_LEVEL = "warn";

// Helper: build a minimal OpenAI-compat /chat/completions JSON response
function makeResponse(content) {
  return {
    choices: [{ message: { role: "assistant", content } }],
  };
}

// Helper: mock the global fetch to return a given JSON body once
function mockFetch(jsonBody) {
  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => jsonBody,
  }));
}

const { llamaChat } = await import("../src/services/llamaService.js");

describe("llamaChat output sanitization", () => {
  test("strips an empty <think></think> block and trailing whitespace", async () => {
    mockFetch(makeResponse("<think>\n\n</think>\n\nHey there. How's it going?"));
    const result = await llamaChat("http://localhost:8081/v1", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(result, "Hey there. How's it going?");
  });

  test("strips a non-empty <think>...</think> block", async () => {
    mockFetch(makeResponse("<think>Some internal reasoning here.\n</think>\nHello!"));
    const result = await llamaChat("http://localhost:8081/v1", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(result, "Hello!");
  });

  test("strips <THINK>...</THINK> case-insensitively", async () => {
    mockFetch(makeResponse("<THINK>reasoning</THINK>\nResponse text."));
    const result = await llamaChat("http://localhost:8081/v1", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(result, "Response text.");
  });

  test("cuts off at [/response] stop token", async () => {
    mockFetch(
      makeResponse(
        "hey, what's up?\n\n[/response] I've got your salutation right! Do you have something specific on your mind today?"
      )
    );
    const result = await llamaChat("http://localhost:8081/v1", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(result, "hey, what's up?");
  });

  test("cuts off at [/RESPONSE] (uppercase variant)", async () => {
    mockFetch(makeResponse("Sure thing.[/RESPONSE] extra text"));
    const result = await llamaChat("http://localhost:8081/v1", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(result, "Sure thing.");
  });

  test("leaves clean responses unchanged", async () => {
    mockFetch(makeResponse("Just a normal reply."));
    const result = await llamaChat("http://localhost:8081/v1", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(result, "Just a normal reply.");
  });

  test("handles both think-block and [/response] in the same response", async () => {
    mockFetch(
      makeResponse("<think>thought</think>\nreal answer\n\n[/response] leftover")
    );
    const result = await llamaChat("http://localhost:8081/v1", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(result, "real answer");
  });
});
