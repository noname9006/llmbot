import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_TOKEN_REMOTE = "test-token";
process.env.CONTEXT_TRIM_SAFETY_MARGIN = "256";
process.env.CONTEXT_TRIM_MIN_MESSAGE_BUDGET = "256";

const {
  trimMessagesForContext,
  truncateToolMessageContent,
  findProtectedFromIndex,
} = await import(`../src/services/contextTrim.js?ctx-trim=${Date.now()}`);
const { estimateMessagesTokens, computeMessageTokenBudget } = await import(
  `../src/utils/contextBudget.js?ctx-budget=${Date.now()}`
);

function longText(chars) {
  return "x".repeat(chars);
}

describe("findProtectedFromIndex()", () => {
  test("uses firstToolAssistantIndex when set", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "tool", content: "{}", tool_call_id: "1" },
    ];
    assert.equal(findProtectedFromIndex(messages, 3), 3);
  });

  test("falls back to last user when no tool assistant index", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "current" },
    ];
    assert.equal(findProtectedFromIndex(messages, null), 3);
  });
});

describe("trimMessagesForContext()", () => {
  test("drops old history in prefix but keeps tool suffix", () => {
    const toolPayload = JSON.stringify({
      ok: true,
      empty: false,
      data: longText(20_000),
      error: null,
      tool: "mintlify-1__search_blend",
      meta: {},
    });
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: longText(4_000) },
      { role: "assistant", content: longText(4_000) },
      { role: "user", content: longText(4_000) },
      { role: "assistant", content: longText(4_000) },
      { role: "user", content: "current question" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", function: { name: "t" } }] },
      { role: "tool", tool_call_id: "tc1", content: toolPayload },
    ];

    const nCtx = 8192;
    const maxTokensOut = 512;
    const tools = Array.from({ length: 14 }, (_, i) => ({
      type: "function",
      function: {
        name: `srv__tool${i}`,
        description: "d".repeat(200),
        parameters: { type: "object", properties: {} },
      },
    }));

    const budget = computeMessageTokenBudget({
      nCtx,
      maxTokensOut,
      tools,
      safetyMargin: 256,
      minMessageBudget: 256,
    });
    assert.ok(budget > 0);

    const { messages: trimmed, stats } = trimMessagesForContext({
      messages,
      tools,
      nCtx,
      maxTokensOut,
      firstToolAssistantIndex: 6,
      round: 2,
    });

    assert.ok(stats.droppedPrefixMessages > 0 || stats.truncatedToolMessages > 0);
    assert.equal(trimmed[0].role, "system");
    assert.equal(trimmed.at(-2).role, "assistant");
    assert.equal(trimmed.at(-1).role, "tool");
    assert.ok(estimateMessagesTokens(trimmed) <= budget + 200);
  });

  test("no-op when nCtx is 0", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const { messages: out, stats } = trimMessagesForContext({
      messages,
      tools: [],
      nCtx: 0,
      maxTokensOut: 512,
    });
    assert.equal(stats.skipped, true);
    assert.equal(out.length, 2);
  });
});

describe("truncateToolMessageContent()", () => {
  test("shortens JSON envelope data field", () => {
    const raw = JSON.stringify({
      ok: true,
      data: longText(10_000),
      tool: "t",
      meta: {},
    });
    const out = truncateToolMessageContent(raw, 500);
    assert.ok(out.length <= 500);
    const parsed = JSON.parse(out);
    assert.equal(parsed.meta.truncated, true);
  });
});
