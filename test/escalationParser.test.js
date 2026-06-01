import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Set required env vars before config.js loads
process.env.DISCORD_TOKEN = "test-token";
process.env.LOG_LEVEL = "warn";

const { parseEscalationBlock, buildEscalationInstruction } = await import(
  "../src/utils/escalationParser.js"
);

describe("parseEscalationBlock()", () => {
  describe("happy path — valid JSON block at the end", () => {
    test("extracts answer and parses should_escalate=false", () => {
      const raw = `Bitcoin is digital gold.\n{"score":2,"should_escalate":false,"reason":"simple fact"}`;
      const { answer, shouldEscalate, score } = parseEscalationBlock(raw);
      assert.equal(answer, "Bitcoin is digital gold.");
      assert.equal(shouldEscalate, false);
      assert.equal(score, 2);
    });

    test("extracts answer and parses should_escalate=true", () => {
      const raw = `Here is a deep analysis.\n{"score":5,"should_escalate":true,"reason":"multi-step reasoning"}`;
      const { answer, shouldEscalate, score } = parseEscalationBlock(raw);
      assert.equal(answer, "Here is a deep analysis.");
      assert.equal(shouldEscalate, true);
      assert.equal(score, 5);
    });

    test("handles JSON with spaces around colons/values", () => {
      const raw = `Short answer.\n{"score": 3, "should_escalate": false, "reason": "medium"}`;
      const { answer, shouldEscalate, score } = parseEscalationBlock(raw);
      assert.equal(answer, "Short answer.");
      assert.equal(shouldEscalate, false);
      assert.equal(score, 3);
    });

    test("trims trailing whitespace/newlines from raw text", () => {
      const raw = `Answer here.\n{"score":1,"should_escalate":false,"reason":"trivial"}\n\n`;
      const { answer, shouldEscalate } = parseEscalationBlock(raw);
      assert.equal(answer, "Answer here.");
      assert.equal(shouldEscalate, false);
    });

    test("handles multi-line answer before the JSON block", () => {
      const raw = `Line one.\nLine two.\nLine three.\n{"score":4,"should_escalate":true,"reason":"complex"}`;
      const { answer, shouldEscalate } = parseEscalationBlock(raw);
      assert.equal(answer, "Line one.\nLine two.\nLine three.");
      assert.equal(shouldEscalate, true);
    });
  });

  describe("fallback — no escalation block present", () => {
    test("returns full text as answer and shouldEscalate=false when no JSON", () => {
      const raw = `Just a plain text response with no JSON.`;
      const { answer, shouldEscalate, score } = parseEscalationBlock(raw);
      assert.equal(answer, raw);
      assert.equal(shouldEscalate, false);
      assert.equal(score, null);
    });

    test("ignores JSON that lacks should_escalate field", () => {
      const raw = `Answer.\n{"score":3,"reason":"no escalate field here"}`;
      const { answer, shouldEscalate, score } = parseEscalationBlock(raw);
      assert.equal(answer, raw.trim());
      assert.equal(shouldEscalate, false);
      assert.equal(score, null);
    });

    test("ignores JSON where should_escalate is not boolean", () => {
      const raw = `Answer.\n{"score":3,"should_escalate":"yes","reason":"wrong type"}`;
      const { answer, shouldEscalate } = parseEscalationBlock(raw);
      assert.equal(answer, raw.trim());
      assert.equal(shouldEscalate, false);
    });

    test("returns full text when JSON is malformed / truncated", () => {
      const raw = `Answer.\n{"score":3,"should_escalate":true`;
      const { answer, shouldEscalate } = parseEscalationBlock(raw);
      assert.equal(answer, raw.trim());
      assert.equal(shouldEscalate, false);
    });

    test("handles empty string input without throwing", () => {
      const { answer, shouldEscalate, score } = parseEscalationBlock("");
      assert.equal(answer, "");
      assert.equal(shouldEscalate, false);
      assert.equal(score, null);
    });
  });

  describe("edge cases", () => {
    test("falls back to full text as answer when JSON is the entire response", () => {
      // Model emitted only the JSON, no prose — answer is empty after stripping,
      // so we fall back to the full text rather than sending an empty message.
      const raw = `{"score":4,"should_escalate":true,"reason":"only json"}`;
      const { answer, shouldEscalate } = parseEscalationBlock(raw);
      // answer falls back to the full text because slicing before `{"` gives ""
      assert.equal(answer, raw.trim());
      assert.equal(shouldEscalate, true);
    });

    test("does not confuse user-authored JSON in the answer with a routing block", () => {
      // The last JSON-like fragment at the end still needs should_escalate to be bool
      const raw = `Here is an example:\n{"key":"value","nested":{"a":1}}\nMore text.`;
      const { answer, shouldEscalate } = parseEscalationBlock(raw);
      assert.equal(answer, raw.trim());
      assert.equal(shouldEscalate, false);
    });

    test("recovers when model appends text after the closing } of the JSON block", () => {
      // Reproduces the real-world case: model leaks __VALE__ after the JSON block
      const raw =
        `Elaborate on what part 🤔\n` +
        `{"score":3,"should_escalate":true,"reason":"clarification"}__VALE__ might wanna weigh in`;
      const { answer, shouldEscalate, score } = parseEscalationBlock(raw);
      assert.equal(shouldEscalate, true, "should escalate despite trailing garbage");
      assert.equal(score, 3);
      assert.ok(answer.includes("Elaborate on what part"), "prose answer preserved");
      assert.ok(!answer.includes('"should_escalate"'), "JSON not in answer");
    });

    test("score is null when not a number", () => {
      const raw = `Answer.\n{"score":"high","should_escalate":true,"reason":"non-numeric score"}`;
      const { score, shouldEscalate } = parseEscalationBlock(raw);
      assert.equal(score, null);
      assert.equal(shouldEscalate, true);
    });
  });
});

describe("buildEscalationInstruction()", () => {
  test("returns a non-empty string", () => {
    const instr = buildEscalationInstruction();
    assert.ok(typeof instr === "string" && instr.length > 0);
  });

  test("mentions should_escalate in the instruction text", () => {
    assert.ok(buildEscalationInstruction().includes("should_escalate"));
  });

  test("mentions score in the instruction text", () => {
    assert.ok(buildEscalationInstruction().includes("score"));
  });

  test("forbids writing __VALE__ or Vale references in answer text", () => {
    const instruction = buildEscalationInstruction();
    assert.ok(instruction.includes("Never write __VALE__ or any Vale reference"));
    assert.ok(!instruction.includes('Do NOT use "cc __VALE__"'));
  });
});
