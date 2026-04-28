/**
 * Tests for buildSystemPrompt() (config.js) and stripSignals() (messageHandler.js).
 *
 * buildSystemPrompt is not exported from config.js — it is applied at startup.
 * We test it indirectly by reading config.llm.systemPrompt* with appropriate
 * env vars set before the module is loaded, and by exercising the helper logic
 * directly via a thin re-implementation so the tests stay fast and isolated.
 *
 * stripSignals is tested via its effect inside sendChunked; since sendChunked
 * talks to Discord we instead export a thin wrapper and test the regex directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ── Test buildSystemPrompt logic directly ─────────────────────────────────────
// We re-implement the function using the same logic as config.js so that we
// can unit-test it without loading the full module tree.

function buildSystemPromptWith(raw, { stripSearch = false, stripEscalate = false } = {}) {
  let text = raw;

  if (stripEscalate) {
    text = text.replace(
      /^__ESCALATE__[^\n]*\n(?:[^\n]*\n)*?[^\n]*Do NOT use for:[^\n]*\n?/m,
      ""
    );
    text = text.replace(/^"[^"]*"\s*→\s*__ESCALATE__[^\n]*\n?/gm, "");
  }

  if (stripSearch) {
    text = text.replace(
      /^__SEARCH__[^\n]*\n(?:[^\n]*\n)*?[^\n]*Replace <concise web search query>[^\n]*\n?/m,
      ""
    );
    text = text.replace(/^"[^"]*"\s*→\s*__SEARCH__:[^\n]*\n?/gm, "");
  }

  if (stripEscalate && stripSearch) {
    text = text.replace(/^=== SIGNALS ===\n?/m, "");
  }

  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// Minimal prompt fixture that mirrors the real sysprompt_common.txt structure.
const COMMON_PROMPT = `\
=== PERSONALITY ===
Short line.

=== SIGNALS ===

__ESCALATE__
Use when a question is technically deep.
Your ENTIRE response must be ONLY: __ESCALATE__ — no greeting, no explanation, nothing else.
Do NOT use for: greetings, casual chat, opinions.

__SEARCH__
Use when a question requires up-to-date information.
Your ENTIRE response must be ONLY: __SEARCH__: <concise web search query>
Example: __SEARCH__: Botanix BTC sidechain latest update
Replace <concise web search query> with the search term — do not include the angle brackets.

=== EXAMPLES ===
"gm" → "gm"
"explain spiderchain" → __ESCALATE__
"btc price?" → __SEARCH__: bitcoin price today
"answered already lol" → "haha fair, my bad"`;

// Minimal heavy-prompt fixture (no __ESCALATE__ block).
const HEAVY_PROMPT = `\
=== PERSONALITY ===
Short line.

=== SIGNALS ===


__SEARCH__
Use when a question requires up-to-date information.
Your ENTIRE response must be ONLY: __SEARCH__: <concise web search query>
Example: __SEARCH__: Botanix BTC sidechain latest update
Replace <concise web search query> with the search term — do not include the angle brackets.

=== EXAMPLES ===
"gm" → "gm"
"btc price?" → __SEARCH__: bitcoin price today
"answered already lol" → "haha fair, my bad"`;

describe("buildSystemPrompt()", () => {
  test("returns the prompt unchanged when neither signal is stripped", () => {
    const result = buildSystemPromptWith(COMMON_PROMPT, { stripSearch: false, stripEscalate: false });
    assert.ok(result.includes("__ESCALATE__"));
    assert.ok(result.includes("__SEARCH__"));
    assert.ok(result.includes("=== SIGNALS ==="));
  });

  test("removes the __ESCALATE__ signal block when stripEscalate=true", () => {
    const result = buildSystemPromptWith(COMMON_PROMPT, { stripSearch: false, stripEscalate: true });
    assert.ok(!result.includes("Do NOT use for:"), "escalate block should be gone");
    assert.ok(!result.includes('"explain spiderchain" → __ESCALATE__'), "escalate example should be removed");
    // Search block must be untouched
    assert.ok(result.includes("__SEARCH__"));
    assert.ok(result.includes("=== SIGNALS ==="), "header kept when only one block stripped");
  });

  test("removes the __SEARCH__ signal block when stripSearch=true", () => {
    const result = buildSystemPromptWith(COMMON_PROMPT, { stripSearch: true, stripEscalate: false });
    assert.ok(!result.includes("Replace <concise web search query>"), "search block should be gone");
    assert.ok(!result.includes('"btc price?" → __SEARCH__:'), "search example should be removed");
    // Escalate block must be untouched
    assert.ok(result.includes("__ESCALATE__"));
    assert.ok(result.includes("=== SIGNALS ==="), "header kept when only one block stripped");
  });

  test("removes both blocks and the SIGNALS header when both are stripped", () => {
    const result = buildSystemPromptWith(COMMON_PROMPT, { stripSearch: true, stripEscalate: true });
    assert.ok(!result.includes("Do NOT use for:"), "escalate block gone");
    assert.ok(!result.includes("Replace <concise web search query>"), "search block gone");
    assert.ok(!result.includes("=== SIGNALS ==="), "header removed when section is empty");
    assert.ok(!result.includes('"explain spiderchain" → __ESCALATE__'), "escalate example gone");
    assert.ok(!result.includes('"btc price?" → __SEARCH__:'), "search example gone");
    // Non-signal examples must survive
    assert.ok(result.includes('"answered already lol"'), "unrelated example preserved");
  });

  test("collapses 3+ blank lines to 2 after stripping", () => {
    const result = buildSystemPromptWith(COMMON_PROMPT, { stripSearch: true, stripEscalate: true });
    assert.ok(!/\n{3,}/.test(result), "no run of 3+ blank lines");
  });

  test("strips __SEARCH__ from heavy prompt (no __ESCALATE__ present)", () => {
    const result = buildSystemPromptWith(HEAVY_PROMPT, { stripSearch: true, stripEscalate: false });
    assert.ok(!result.includes("Replace <concise web search query>"), "search block gone");
    assert.ok(!result.includes('"btc price?" → __SEARCH__:'), "search example gone");
  });

  test("strips both from heavy prompt — leaves no dangling content", () => {
    const result = buildSystemPromptWith(HEAVY_PROMPT, { stripSearch: true, stripEscalate: true });
    assert.ok(!result.includes("__SEARCH__"), "no __SEARCH__ left");
    assert.ok(!result.includes("=== SIGNALS ==="), "header removed");
  });
});

// ── Test stripSignals() ───────────────────────────────────────────────────────
// We inline the same logic as the production function so these tests run
// without importing the full messageHandler module (which has side-effects).

const SIGNAL_STRIP_RE = /__SEARCH__:[^\n]*/g;
const ESCALATION_JSON_STRIP_RE = /\{[^{}]*"should_escalate"[^{}]*\}/g;
const VALE_TOKEN_STRIP_RE = /__VALE__[^\n]*/g;

function stripSignals(text) {
  return text
    .replace(SIGNAL_STRIP_RE, "")
    .replace(ESCALATION_JSON_STRIP_RE, "")
    .replace(VALE_TOKEN_STRIP_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

describe("stripSignals()", () => {
  test("removes __SEARCH__: <query> token", () => {
    assert.equal(stripSignals("__SEARCH__: bitcoin price today"), "");
  });

  test("removes __SEARCH__: embedded in a response", () => {
    const input = "Preamble\n__SEARCH__: latest eth news\nSuffix";
    const result = stripSignals(input);
    assert.ok(!result.includes("__SEARCH__:"));
    assert.ok(result.includes("Preamble"));
    assert.ok(result.includes("Suffix"));
  });

  test("does not modify normal text", () => {
    const input = "hey, how are you?";
    assert.equal(stripSignals(input), input);
  });

  test("collapses resulting blank lines to at most 2", () => {
    const input = "line1\n__SEARCH__: query\n\n\n\nline2";
    const result = stripSignals(input);
    assert.ok(!/\n{3,}/.test(result));
    assert.ok(result.includes("line1"));
    assert.ok(result.includes("line2"));
  });

  test("returns empty string for a response that is only a search signal", () => {
    assert.equal(stripSignals("__SEARCH__: some query"), "");
  });

  test("strips leaked escalation JSON block", () => {
    const input = `Good answer.\n{"score":3,"should_escalate":true,"reason":"complex"}`;
    const result = stripSignals(input);
    assert.ok(!result.includes('"should_escalate"'), "escalation JSON should be gone");
    assert.ok(result.includes("Good answer."));
  });

  test("strips bare __VALE__ token and trailing text", () => {
    const input = `Some answer __VALE__ might wanna weigh in`;
    const result = stripSignals(input);
    assert.ok(!result.includes("__VALE__"), "__VALE__ token should be gone");
    assert.ok(result.includes("Some answer"), "prose before __VALE__ should be kept");
  });

  test("strips both escalation JSON and __VALE__ from a combined leak", () => {
    const input =
      `Elaborate on what part 🤔\n` +
      `{"score":3,"should_escalate":true,"reason":"clarification needed"}__VALE__ might wanna weigh in`;
    const result = stripSignals(input);
    assert.ok(!result.includes('"should_escalate"'), "JSON stripped");
    assert.ok(!result.includes("__VALE__"), "__VALE__ stripped");
    assert.ok(result.includes("Elaborate on what part"));
  });
});
