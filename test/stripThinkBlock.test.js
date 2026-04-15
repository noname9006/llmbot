import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Set required env vars BEFORE any module that transitively loads config.js
process.env.DISCORD_TOKEN = "test-token";
process.env.LOG_LEVEL = "warn";

const { stripThinkBlock } = await import("../src/handlers/messageHandler.js");

describe("stripThinkBlock()", () => {
  test("returns the string unchanged when <channel|> is absent", () => {
    const text = "Hello, world!";
    assert.equal(stripThinkBlock(text), text);
  });

  test("returns the portion after <channel|> when the marker is present", () => {
    const text = "<|channel>thought\ninternal reasoning\n<channel|>\nvisible answer";
    assert.equal(stripThinkBlock(text), "\nvisible answer");
  });

  test("uses the LAST occurrence of <channel|> when multiple markers are present", () => {
    const text = "first<channel|>middle<channel|>final answer";
    assert.equal(stripThinkBlock(text), "final answer");
  });

  test("returns an empty string when the response ends with <channel|>", () => {
    const text = "<|channel>thought\nreasoning<channel|>";
    assert.equal(stripThinkBlock(text), "");
  });

  test("returns an empty string unchanged when the input is empty", () => {
    assert.equal(stripThinkBlock(""), "");
  });

  test("is a no-op for normal text without think blocks", () => {
    const text = "This is a plain response with no special markers.";
    assert.equal(stripThinkBlock(text), text);
  });
});
