import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// Set required env vars BEFORE any module that transitively loads config.js
process.env.DISCORD_TOKEN = "test-token";
process.env.LOG_LEVEL = "warn"; // suppress info/debug noise; keep warn for assertions
process.env.HISTORY_MAX_PAIRS = "2"; // 2 pairs → 4-message history max for easy testing

// Dynamic import so env vars above are applied before config.js is evaluated
const { historyService } = await import("../src/services/historyService.js");

// ── helpers ───────────────────────────────────────────────────────────────────

/** Capture console.log calls that come from logger.warn during a block. */
function captureWarnLogs(fn) {
  const captured = [];
  const orig = console.log;
  console.log = (...args) => {
    const msg = args.join(" ");
    if (msg.includes("[WARN]")) captured.push(msg);
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return captured;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("HistoryService", () => {
  // Use a fresh userId per test to avoid cross-test state
  let uid = 0;
  function nextUser() {
    return `test-user-${++uid}`;
  }

  describe("getMessages()", () => {
    test("prepends the system prompt to an empty history", () => {
      const userId = nextUser();
      const msgs = historyService.getMessages(userId);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, "system");
    });

    test("returns system prompt + stored messages in order", () => {
      const userId = nextUser();
      historyService.pushUser(userId, "hello");
      historyService.pushAssistant(userId, "hi there");
      const msgs = historyService.getMessages(userId);
      assert.equal(msgs.length, 3); // system + 2
      assert.equal(msgs[1].role, "user");
      assert.equal(msgs[1].content, "hello");
      assert.equal(msgs[2].role, "assistant");
      assert.equal(msgs[2].content, "hi there");
    });
  });

  describe("#trim — length enforcement", () => {
    test("keeps exactly maxPairs * 2 messages when history exceeds the cap", () => {
      const userId = nextUser();
      // Push 3 full pairs (6 messages); cap is 2 pairs (4 messages)
      historyService.pushUser(userId, "u1");
      historyService.pushAssistant(userId, "a1");
      historyService.pushUser(userId, "u2");
      historyService.pushAssistant(userId, "a2");
      historyService.pushUser(userId, "u3");
      historyService.pushAssistant(userId, "a3");
      const msgs = historyService.getMessages(userId); // system + 4 history
      assert.equal(msgs.length, 5);
      // Oldest retained pair is u2/a2
      assert.equal(msgs[1].content, "u2");
      assert.equal(msgs[2].content, "a2");
    });

    test("does not remove messages when history is exactly at the cap", () => {
      const userId = nextUser();
      historyService.pushUser(userId, "u1");
      historyService.pushAssistant(userId, "a1");
      historyService.pushUser(userId, "u2");
      historyService.pushAssistant(userId, "a2");
      const msgs = historyService.getMessages(userId);
      assert.equal(msgs.length, 5); // system + 4
      assert.equal(msgs[1].content, "u1");
    });
  });

  describe("#trim — leading-assistant-turn removal", () => {
    test("removes a leading assistant turn left after length truncation", () => {
      const userId = nextUser();
      // Push 2 full pairs then a lone user message → history becomes:
      //   [u1, a1, u2, a2, u3]  (5 items)
      // Trim to 4: splice(0, 1) → [a1, u2, a2, u3]
      // Leading-asst removal: [u2, a2, u3]
      historyService.pushUser(userId, "u1");
      historyService.pushAssistant(userId, "a1");
      historyService.pushUser(userId, "u2");
      historyService.pushAssistant(userId, "a2");
      historyService.pushUser(userId, "u3"); // triggers trim

      const msgs = historyService.getMessages(userId); // system + u2, a2, u3
      assert.equal(msgs.length, 4);
      assert.equal(msgs[1].role, "user");
      assert.equal(msgs[1].content, "u2");
    });

    test("emits a logger.warn when leading assistant turns are removed", () => {
      const userId = nextUser();
      historyService.pushUser(userId, "u1");
      historyService.pushAssistant(userId, "a1");
      historyService.pushUser(userId, "u2");
      historyService.pushAssistant(userId, "a2");

      const logs = captureWarnLogs(() => {
        historyService.pushUser(userId, "u3"); // triggers leading-asst removal
      });

      assert.ok(
        logs.some((m) => m.includes("leading assistant")),
        `Expected a warn about leading assistant turns, got: ${JSON.stringify(logs)}`
      );
    });

    test("does not warn when trim produces a user-leading history", () => {
      const userId = nextUser();
      // Push 2 full pairs, then add a 3rd pair.
      // When the 5th message (u3) is pushed: trim leaves [a1, u2, a2, u3] → WARN fired.
      // When the 6th message (a3) is pushed: trim leaves [u2, a2, u3, a3] → no leading asst → no WARN.
      historyService.pushUser(userId, "u1");
      historyService.pushAssistant(userId, "a1");
      historyService.pushUser(userId, "u2");
      historyService.pushAssistant(userId, "a2");
      historyService.pushUser(userId, "u3"); // triggers warn — outside assertion window

      const logs = captureWarnLogs(() => {
        historyService.pushAssistant(userId, "a3"); // trim removes u1+a1; result starts with u2 → no warn
      });

      assert.equal(
        logs.filter((m) => m.includes("leading assistant")).length,
        0,
        "Should not warn when first item after trim is a user message"
      );
    });
  });

  describe("popLastUser()", () => {
    test("removes the most recently pushed user message", () => {
      const userId = nextUser();
      historyService.pushUser(userId, "first");
      historyService.pushAssistant(userId, "reply");
      historyService.pushUser(userId, "second");
      historyService.popLastUser(userId);
      const msgs = historyService.getMessages(userId);
      // system + first + reply = 3
      assert.equal(msgs.length, 3);
      assert.equal(msgs[msgs.length - 1].content, "reply");
    });

    test("is a no-op for an unknown user", () => {
      assert.doesNotThrow(() => historyService.popLastUser("no-such-user"));
    });
  });

  describe("reset()", () => {
    test("clears history for the given user", () => {
      const userId = nextUser();
      historyService.pushUser(userId, "msg");
      historyService.reset(userId);
      const msgs = historyService.getMessages(userId);
      assert.equal(msgs.length, 1); // only system prompt
    });
  });
});
