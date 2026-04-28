/**
 * Parses the LLM self-routing JSON block from a remote model response.
 *
 * The remote model is instructed to append a JSON block at the end of its
 * answer with this format:
 *   {"score": <1-5>, "should_escalate": <bool>, "reason": "<one-line>"}
 *
 * This function splits the raw response into (answer text, JSON block) and
 * returns the parsed result.  On any parse failure it returns a safe fallback
 * of `{ shouldEscalate: false }` so inference always continues.
 *
 * @param {string} rawText  - raw LLM response (think blocks already stripped)
 * @returns {{ answer: string, shouldEscalate: boolean, score: number|null }}
 */
export function parseEscalationBlock(rawText) {
  const trimmed = rawText.trimEnd();

  // Walk backwards to find the last `{"` that opens a potential JSON object
  const jsonStart = trimmed.lastIndexOf('{"');
  if (jsonStart === -1) {
    return { answer: trimmed.trim(), shouldEscalate: false, score: null };
  }

  const potentialJson = trimmed.slice(jsonStart);
  // Must close with `}` — multi-line or truncated blocks are rejected
  if (!potentialJson.endsWith("}")) {
    return { answer: trimmed.trim(), shouldEscalate: false, score: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(potentialJson);
  } catch {
    return { answer: trimmed.trim(), shouldEscalate: false, score: null };
  }

  // Must have a boolean `should_escalate` to be a routing block (not user JSON)
  if (typeof parsed.should_escalate !== "boolean") {
    return { answer: trimmed.trim(), shouldEscalate: false, score: null };
  }

  const answer = trimmed.slice(0, jsonStart).trimEnd();
  return {
    // Fall back to full text if the model emitted JSON only (no prose answer)
    answer: answer || trimmed.trim(),
    shouldEscalate: parsed.should_escalate === true,
    score: typeof parsed.score === "number" ? parsed.score : null,
  };
}

/**
 * Returns an ephemeral routing instruction to inject as a user turn in the
 * message array before calling the remote model.
 *
 * It instructs the model to output its normal answer followed by a one-line
 * JSON complexity-assessment block.  The block is parsed by
 * `parseEscalationBlock` to decide whether to escalate to the local model.
 *
 * Only inject this when the local bot is available; otherwise routing is
 * unnecessary and the extra tokens waste context.
 *
 * @returns {string}
 */
export function buildEscalationInstruction() {
  return (
    `[SYSTEM ROUTING] After your reply, append exactly one JSON block on a new line:\n` +
    `{"score":<1-5>,"should_escalate":<true|false>,"reason":"<one-line>"}\n\n` +
    `Score guide: 1-2=simple fact/definition, 3=comparison/brief analysis, ` +
    `4-5=deep code/math/multi-step reasoning/ambiguity.\n` +
    `Set should_escalate=true when score>=4 or you are uncertain and more depth ` +
    `would genuinely help the user.\n` +
    `Do not change your style or content. Output the JSON block at the very end; ` +
    `no extra text after it.`
  );
}
