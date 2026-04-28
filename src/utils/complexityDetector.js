import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Analyses a user message and determines whether it is a "complex" request
 * that warrants routing to the LOCAL model for a deeper answer.
 *
 * All thresholds and keyword lists are driven by `config.complexity` so they
 * can be tuned via environment variables without code changes.
 *
 * @param {string} userText  - the raw user message (mentions already stripped)
 * @returns {{ complex: boolean, reasons: string[] }}
 */
export function isComplexRequest(userText) {
  const reasons = [];
  const text = userText;
  const lower = text.toLowerCase();

  // 1. Long prompt
  if (text.length >= config.complexity.promptLength) {
    reasons.push(`long prompt (${text.length} chars >= ${config.complexity.promptLength})`);
  }

  // 2. Contains a fenced code block (``` … ```)
  if (text.includes("```")) {
    reasons.push("contains fenced code block");
  }

  // 3. Code-related keywords
  const matchedCode = config.complexity.keywordsCode.find(
    (kw) => kw && lower.includes(kw.toLowerCase())
  );
  if (matchedCode) {
    reasons.push(`code keyword: "${matchedCode}"`);
  }

  // 4. Planning / architecture keywords
  const matchedPlan = config.complexity.keywordsPlan.find(
    (kw) => kw && lower.includes(kw.toLowerCase())
  );
  if (matchedPlan) {
    reasons.push(`plan keyword: "${matchedPlan}"`);
  }

  // 5. Explicit request for the local model
  const explicitPatterns = ["use local", "ask local", "local model"];
  const matchedExplicit = explicitPatterns.find((p) => lower.includes(p));
  if (matchedExplicit) {
    reasons.push(`explicit local request: "${matchedExplicit}"`);
  }

  if (reasons.length > 0) {
    logger.debug(`[complexityDetector] complex (${reasons.join("; ")})`);
  }

  return { complex: reasons.length > 0, reasons };
}
