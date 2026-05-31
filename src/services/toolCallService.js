import { config } from "../config.js";
import { logger } from "../logger.js";
import { getMcpTools, callMcpTool } from "./mcpService.js";
import { llamaChatCompletion } from "./llamaService.js";

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_EVIDENCE_DEPTH = 6;
const MAX_SEARCH_RESULT_ITEMS = 2;
const DOC_SEARCH_TOOL_RE = /(?:^|__)searchDocumentation$/i;
const DOC_GET_PAGE_TOOL_RE = /(?:^|__)getPage$/i;
const SEARCH_RESULT_COLLECTION_KEYS = ["results", "items", "hits", "pages", "documents", "entries"];
const EVIDENCE_FIELD_KEY_RE = /(title|snippet|summary|content|text|markdown|url|uri|href|path|slug|body|page)/i;
const DOC_NO_RESULTS_MESSAGE =
  "I couldn't retrieve any documentation results from the docs service right now, so I can't confirm any docs findings or links.";
const DOC_TOOL_UNAVAILABLE_FALLBACK =
  "The documentation tool is currently unavailable. Please answer from your knowledge and let the user know the docs couldn't be retrieved.";
const TOOL_CALL_FORMAT_REMINDER =
  "Remember: when you need to use a tool, call it using the function calling API — do not write 'call toolname' as text.";
const MALFORMED_TOOL_CALL_RE =
  /\b(?:call\s+[a-z0-9_-]+__[a-z0-9_-]+(?:\{[\s\S]*?\})?(?:<?tool_call\|?>?)?|[a-z0-9_-]+__[a-z0-9_-]+(?:\{[\s\S]*?\})?<?tool_call\|?>?)/i;
const DOC_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "about",
  "docs",
  "documentation",
  "for",
  "guide",
  "how",
  "is",
  "latest",
  "link",
  "mechanism",
  "of",
  "please",
  "share",
  "the",
  "to",
]);
const PAGE_CANDIDATE_KEYS = ["path", "pagePath", "slug", "id", "url", "uri", "href"];

/** Patterns that indicate the model is narrating a future tool call instead of making one. */
const STALLING_PATTERNS = [
  /\b(let me|i('ll| will|'m going to)|gonna|going to|i need to)\s+(check|search|look|find|fetch|query|pull|get)\b/i,
  /\b(checking|searching|looking up|fetching|querying|pulling|running a search)\b/i,
  /\bhold on\b/i,
  /\bone (sec|second|moment|min|minute)\b/i,
  /\b(i gotta|gotta)\b.{0,20}\b(docs|documentation|data|info|search)\b/i,
  /\bgotta (run|do) the search\b/i,
  /\blmk when it comes back\b/i,
  /\bwhen it comes back\b/i,
];

function looksLikeStalling(content) {
  if (!content) return false;
  return STALLING_PATTERNS.some((re) => re.test(content));
}

function sanitizeToolErrorMessage(err) {
  const msg = err?.message ? String(err.message) : "unknown error";
  return /(token|secret|password|api[_-]?key|authorization|auth|bearer|cookie|session)/i.test(msg)
    ? "tool execution failed due to a protected error"
    : msg;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (err) {
    return JSON.stringify({
      ok: false,
      empty: false,
      data: null,
      error: `serialization_error: ${sanitizeToolErrorMessage(err)}`,
      tool: "tool-result",
      meta: {},
    });
  }
}

function previewArrayForLog(values) {
  if (!Array.isArray(values)) return "[]";
  const preview = values.length > 3 ? [...values.slice(0, 3), "..."] : values;
  return safeJsonStringify(preview);
}

function describeTrimDataShape(data) {
  return Array.isArray(data) ? "array" : "object";
}

function truncateString(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function serializeToolResult(result, activeLogger = logger) {
  const base = {
    ok: Boolean(result?.ok),
    empty: Boolean(result?.empty),
    data: result?.data ?? null,
    error: result?.error ?? null,
    tool: result?.tool ?? "tool",
    meta: result?.meta ?? {},
  };

  let text = safeJsonStringify(base);
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    return text;
  }

  const shortened = {
    ...base,
    data: typeof base.data === "string"
      ? truncateString(base.data, Math.floor(MAX_TOOL_RESULT_CHARS / 2))
      : truncateString(safeJsonStringify(base.data), Math.floor(MAX_TOOL_RESULT_CHARS / 2)),
    meta: {
      ...base.meta,
      truncated: true,
    },
  };
  text = safeJsonStringify(shortened);
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    activeLogger.warn(
      `[tool-call] Tool ${base.tool} result envelope exceeded ${MAX_TOOL_RESULT_CHARS} chars; truncating model payload`
    );
    return text;
  }

  const fallback = {
    ...shortened,
    data: truncateString(String(shortened.data ?? ""), Math.floor(MAX_TOOL_RESULT_CHARS / 3)),
  };
  activeLogger.warn(
    `[tool-call] Tool ${base.tool} result envelope exceeded ${MAX_TOOL_RESULT_CHARS} chars; truncating model payload`
  );
  return truncateString(safeJsonStringify(fallback), MAX_TOOL_RESULT_CHARS);
}

function splitToolName(toolName) {
  const separatorIndex = String(toolName).indexOf("__");
  if (separatorIndex === -1) {
    return { serverName: "", originalName: String(toolName) };
  }
  return {
    serverName: toolName.slice(0, separatorIndex),
    originalName: toolName.slice(separatorIndex + 2),
  };
}

function isDocsSearchTool(toolName) {
  return DOC_SEARCH_TOOL_RE.test(String(toolName));
}

function isDocsGetPageTool(toolName) {
  return DOC_GET_PAGE_TOOL_RE.test(String(toolName));
}

function appendToolSourcesToFinalResponse(content, sourceUrls) {
  if (sourceUrls.size === 0) return content ?? "";
  const answer = content ?? "";
  const missingSources = [...sourceUrls].filter((url) => {
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sourceLineRe = new RegExp(`^Source:\\s*${escapedUrl}$`, "m");
    return !sourceLineRe.test(answer);
  });
  if (missingSources.length === 0) return answer;
  const limitedSources = missingSources.slice(0, 2);
  const sourceLines = limitedSources.map((url) => `Source: ${url}`).join("\n");
  return answer.trim()
    ? `${answer.trimEnd()}\n\n${sourceLines}`
    : sourceLines;
}

function hasConcreteEvidence(value, depth = 0) {
  if (depth > MAX_EVIDENCE_DEPTH || value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasConcreteEvidence(item, depth + 1));
  if (typeof value !== "object") return true;

  for (const [key, child] of Object.entries(value)) {
    if (EVIDENCE_FIELD_KEY_RE.test(key)) {
      if (hasConcreteEvidence(child, depth + 1)) return true;
    }
  }

  return Object.values(value).some((child) => hasConcreteEvidence(child, depth + 1));
}

function isGroundedToolResult(result) {
  return Boolean(
    result?.ok &&
    !result?.empty &&
    ((result?.sources?.length ?? 0) > 0 || hasConcreteEvidence(result?.data))
  );
}

function buildToolFailureResult(toolName, error, extraMeta = {}) {
  return {
    ok: false,
    empty: false,
    data: null,
    error,
    tool: toolName,
    meta: {
      rawLength: 0,
      parsedLength: 0,
      ...extraMeta,
    },
    sources: [],
  };
}

function buildToolEmptyResult(toolName, extraMeta = {}) {
  return {
    ok: true,
    empty: true,
    data: null,
    error: null,
    tool: toolName,
    meta: {
      rawLength: 0,
      parsedLength: 0,
      ...extraMeta,
    },
    sources: [],
  };
}

function summarizeAttempt(toolName, args, result, fallbackStep) {
  return {
    tool: toolName,
    argsSummary: args?.query ?? safeJsonStringify(args),
    ok: Boolean(result?.ok),
    empty: Boolean(result?.empty),
    error: result?.error ?? null,
    fallbackStep,
  };
}

function attachAttemptMetadata(result, attempts) {
  return {
    ...result,
    meta: {
      ...(result?.meta ?? {}),
      attempts,
      fallbackCount: Math.max(0, attempts.length - 1),
    },
  };
}

function trimSearchResultData(result, maxItems = MAX_SEARCH_RESULT_ITEMS) {
  if (!result || result.data == null) return result;

  const { data } = result;
  if (Array.isArray(data)) {
    return { ...result, data: data.slice(0, maxItems) };
  }

  if (typeof data !== "object") return result;

  let trimmedData = data;
  let changed = false;

  for (const key of SEARCH_RESULT_COLLECTION_KEYS) {
    if (Array.isArray(data[key])) {
      if (!changed) trimmedData = { ...data };
      trimmedData[key] = data[key].slice(0, maxItems);
      changed = true;
    }
  }

  if (Array.isArray(data.content)) {
    if (!changed) trimmedData = { ...data };
    trimmedData.content = data.content.slice(0, maxItems);
    changed = true;
  }

  if (!changed) return result;
  return { ...result, data: trimmedData };
}

function buildDocsQueryVariants(query) {
  const base = String(query ?? "").trim();
  const variants = [];
  const seen = new Set();
  const add = (value) => {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    variants.push(normalized);
  };

  const words = base.toLowerCase().split(/\s+/).filter(Boolean);
  const hasContextKeyword =
    /(how|why|when|where|overview|introduction|guide|tutorial|integration|api|setup|install|configure)/i.test(
      base
    );
  const hasEntityPromptPrefix = /^(what\s+(is|are)|tell\s+me\s+about)\s+/i.test(base);
  const isLikelyBareEntity = !hasContextKeyword && (words.length <= 1 || hasEntityPromptPrefix);

  if (isLikelyBareEntity) {
    const entityName = base.replace(/^(what\s+(is|are)|tell\s+me\s+about)\s+/i, "").trim();

    if (entityName && entityName !== base) {
      logger.debug(
        `[tool-call] Transformed bare query "${base}" → added overview/intro variants for "${entityName}"`
      );
    }

    if (entityName) {
      add(`${entityName} overview`);
      add(`${entityName} introduction`);
    }
    add(base);
  } else {
    add(base);
  }

  const cleaned = base
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !DOC_QUERY_STOPWORDS.has(token.toLowerCase()))
    .join(" ");
  add(cleaned);

  return variants.length > 0 ? variants : [base];
}

function getDocsSearchToolCandidates(toolName, tools) {
  const { originalName } = splitToolName(toolName);
  const matches = tools
    .filter((tool) => tool?._originalName === originalName && tool?.function?.name)
    .map((tool) => tool.function.name);

  const deduped = [...new Set(matches)];
  return deduped.sort((left, right) => {
    if (left === toolName) return -1;
    if (right === toolName) return 1;
    if (left.startsWith("gitbook-1__")) return -1;
    if (right.startsWith("gitbook-1__")) return 1;
    return left.localeCompare(right);
  });
}

function extractPageCandidates(value, candidates = [], depth = 0) {
  if (depth > MAX_EVIDENCE_DEPTH || value == null) return candidates;
  if (Array.isArray(value)) {
    for (const item of value) extractPageCandidates(item, candidates, depth + 1);
    return candidates;
  }
  if (typeof value !== "object") return candidates;

  const candidate = {};
  for (const key of PAGE_CANDIDATE_KEYS) {
    if (typeof value[key] === "string" && value[key].trim()) {
      candidate[key] = value[key].trim();
    }
  }
  if (Object.keys(candidate).length > 0) {
    candidates.push(candidate);
  }

  for (const child of Object.values(value)) {
    extractPageCandidates(child, candidates, depth + 1);
  }

  return candidates;
}

function buildGetPageArgs(toolDefinition, candidate) {
  const properties = Object.keys(toolDefinition?.function?.parameters?.properties ?? {});
  const keysToTry = properties.length > 0 ? properties : ["path"];

  const aliases = {
    path: ["path", "pagePath", "slug", "url", "uri", "href", "id"],
    pagePath: ["pagePath", "path", "slug", "url", "uri", "href", "id"],
    slug: ["slug", "path", "pagePath", "id", "url", "uri", "href"],
    id: ["id", "slug", "path", "pagePath", "url", "uri", "href"],
    pageId: ["id", "slug", "path", "pagePath"],
    url: ["url", "uri", "href", "path", "pagePath"],
    uri: ["uri", "url", "href", "path", "pagePath"],
  };

  for (const property of keysToTry) {
    const lookupOrder = aliases[property] ?? [property, ...PAGE_CANDIDATE_KEYS];
    const matchKey = lookupOrder.find((key) => typeof candidate[key] === "string" && candidate[key].trim());
    if (matchKey) {
      return { [property]: candidate[matchKey] };
    }
  }

  return null;
}

const RANKED_COLLECTION_KEYS = ["results", "items", "hits", "pages", "documents", "entries"];

function extractTopRankedSourceUrls(searchResult) {
  const data = searchResult?.data;
  if (!data) return [];

  if (Array.isArray(data)) {
    const first = data[0];
    const url = first?.url ?? first?.uri ?? first?.href;
    return url ? [url] : [];
  }

  if (typeof data === "object") {
    for (const key of RANKED_COLLECTION_KEYS) {
      if (Array.isArray(data[key]) && data[key].length > 0) {
        const first = data[key][0];
        const url = first?.url ?? first?.uri ?? first?.href;
        if (url) return [url];
      }
    }
    if (
      typeof data.structuredContent === "object" &&
      data.structuredContent !== null &&
      !Array.isArray(data.structuredContent)
    ) {
      for (const key of RANKED_COLLECTION_KEYS) {
        if (Array.isArray(data.structuredContent[key]) && data.structuredContent[key].length > 0) {
          const first = data.structuredContent[key][0];
          const url = first?.url ?? first?.uri ?? first?.href;
          if (url) return [url];
        }
      }
    }
    const url = data.url ?? data.uri ?? data.href;
    return url ? [url] : [];
  }

  return [];
}

async function maybeFetchDocsPage(searchToolName, searchResult, tools, deps, initialFallbackStep) {
  const { serverName } = splitToolName(searchToolName);
  const rawCandidates = extractPageCandidates(searchResult?.data);
  const uniqueCandidates = [];
  const seen = new Set();
  for (const candidate of rawCandidates) {
    const key = safeJsonStringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCandidates.push(candidate);
  }
  deps.logger.debug(
    `[tool-call] maybeFetchDocsPage: ${uniqueCandidates.length} unique page candidates from search result`
  );

  const getPageTool = tools.find((tool) =>
    tool?._serverName === serverName && isDocsGetPageTool(tool?.function?.name)
  );
  if (!getPageTool) {
    deps.logger.debug(`[tool-call] maybeFetchDocsPage: no getPage tool found for server=${serverName} — skipping`);
    return { result: null, attempts: [] };
  }

  const attempts = [];
  let fallbackStep = initialFallbackStep;
  for (const candidate of uniqueCandidates.slice(0, 2)) {
    const pageArgs = buildGetPageArgs(getPageTool, candidate);
    if (!pageArgs) continue;
    deps.logger.debug(
      `[tool-call] docs-fallback ${JSON.stringify({
        tool: getPageTool.function.name,
        fallbackStep,
        strategy: "getPage",
        args: pageArgs,
      })}`
    );
    const pageResult = await deps.callMcpTool(getPageTool.function.name, pageArgs, { fallbackStep });
    attempts.push(summarizeAttempt(getPageTool.function.name, pageArgs, pageResult, fallbackStep));
    if (pageResult?.ok && !pageResult?.empty) {
      const canonicalUrl = candidate?.url ?? candidate?.uri ?? candidate?.href ?? null;
      deps.logger.debug(`[tool-call] getPage succeeded — canonicalUrl=${canonicalUrl}`);
      return { result: pageResult, attempts, canonicalUrl };
    }
    fallbackStep += 1;
  }

  return { result: null, attempts };
}

/**
 * @param {string} toolName
 * @param {object} args
 * @param {{
 *   tools?: Array<any>,
 *   getMcpTools?: () => Array<any>,
 *   callMcpTool?: typeof callMcpTool,
 *   logger?: typeof logger
 * }} [deps]
 * @returns {Promise<{result: any, grounded: boolean, sourceUrls: string[], docsSearchAttempted: boolean}>}
 */
export async function executeToolCallWithFallback(toolName, args, deps = {}) {
  const effectiveDeps = {
    tools: deps.tools ?? deps.getMcpTools?.() ?? getMcpTools(),
    callMcpTool: deps.callMcpTool ?? callMcpTool,
    logger: deps.logger ?? logger,
  };
  const docsSearchTool = isDocsSearchTool(toolName);
  effectiveDeps.logger.debug(
    `[tool-call] executeToolCallWithFallback tool=${toolName} isDocsSearch=${docsSearchTool}`
  );

  if (!docsSearchTool) {
    const result = await effectiveDeps.callMcpTool(toolName, args, { fallbackStep: 0 });
    return {
      result,
      grounded: isGroundedToolResult(result),
      sourceUrls: result?.sources ?? [],
      docsSearchAttempted: false,
    };
  }

  const queryVariants = buildDocsQueryVariants(args?.query);
  effectiveDeps.logger.debug(`[tool-call] query variants: ${previewArrayForLog(queryVariants)}`);
  const searchTools = getDocsSearchToolCandidates(toolName, effectiveDeps.tools);
  effectiveDeps.logger.debug(
    `[tool-call] search tool candidates (${searchTools.length}): ${previewArrayForLog(searchTools)}`
  );
  const attempts = [];
  let fallbackStep = 0;
  let lastError = null;

  for (const [toolIndex, searchToolName] of searchTools.entries()) {
    const queriesForTool = toolIndex === 0 ? queryVariants : queryVariants.slice(0, 1);
    for (const query of queriesForTool) {
      const searchArgs = { ...args, query };
      if (fallbackStep > 0) {
        effectiveDeps.logger.debug(
          `[tool-call] docs-fallback ${JSON.stringify({
            tool: searchToolName,
            fallbackStep,
            strategy: "searchDocumentation",
            args: searchArgs,
          })}`
        );
      }
      const searchResult = await effectiveDeps.callMcpTool(searchToolName, searchArgs, { fallbackStep });
      attempts.push(summarizeAttempt(searchToolName, searchArgs, searchResult, fallbackStep));

      if (searchResult?.ok && !searchResult?.empty) {
        const pageFetch = await maybeFetchDocsPage(
          searchToolName,
          searchResult,
          effectiveDeps.tools,
          effectiveDeps,
          fallbackStep + 1
        );
        attempts.push(...pageFetch.attempts);
        if (pageFetch.result?.ok && !pageFetch.result?.empty) {
          const result = attachAttemptMetadata(pageFetch.result, attempts);
          const pageSourceUrls = pageFetch.canonicalUrl ? [pageFetch.canonicalUrl] : [];
          return {
            result,
            grounded: isGroundedToolResult(result),
            sourceUrls: pageSourceUrls,
            docsSearchAttempted: true,
          };
        }

        effectiveDeps.logger.debug(
          "[tool-call] getPage unavailable or failed — using trimmed search result (fallback path)"
        );
        const trimmedSearchResult = trimSearchResultData(searchResult, MAX_SEARCH_RESULT_ITEMS);
        const trimChanged = safeJsonStringify(trimmedSearchResult?.data) !== safeJsonStringify(searchResult?.data);
        effectiveDeps.logger.debug(
          `[tool-call] trimSearchResultData: maxItems=${MAX_SEARCH_RESULT_ITEMS} data shape=${describeTrimDataShape(searchResult?.data)} changed=${trimChanged}`
        );
        const sourceUrls = extractTopRankedSourceUrls(searchResult);
        effectiveDeps.logger.debug(
          `[tool-call] extractTopRankedSourceUrls: picked ${sourceUrls.length} url(s): ${previewArrayForLog(sourceUrls)}`
        );
        const result = attachAttemptMetadata(trimmedSearchResult, attempts);
        return {
          result,
          grounded: isGroundedToolResult(result),
          sourceUrls,
          docsSearchAttempted: true,
        };
      }

      if (!searchResult?.ok && searchResult?.error) {
        lastError = searchResult.error;
      }
      fallbackStep += 1;
    }
  }

  const result = attachAttemptMetadata(
    lastError
      ? buildToolFailureResult(toolName, lastError)
      : buildToolEmptyResult(toolName),
    attempts
  );
  return {
    result,
    grounded: false,
    sourceUrls: result.sources ?? [],
    docsSearchAttempted: true,
  };
}

/**
 * @param {string} baseUrl
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]
 * @param {{
 *   mcpEnabled?: boolean,
 *   getMcpTools?: typeof getMcpTools,
 *   callMcpTool?: typeof callMcpTool,
 *   llamaChatCompletion?: typeof llamaChatCompletion,
 *   logger?: typeof logger
 * }} [deps]
 * @returns {Promise<string>}
 */
export async function llamaWithToolsInternal(baseUrl, messages, opts = {}, deps = {}) {
  const effectiveDeps = {
    mcpEnabled: deps.mcpEnabled ?? config.mcp.enabled,
    getMcpTools: deps.getMcpTools ?? getMcpTools,
    callMcpTool: deps.callMcpTool ?? callMcpTool,
    llamaChatCompletion: deps.llamaChatCompletion ?? llamaChatCompletion,
    logger: deps.logger ?? logger,
  };
  const tools = effectiveDeps.getMcpTools();
  effectiveDeps.logger.debug(
    `[tool-call] llamaWithTools url=${baseUrl} mcpEnabled=${effectiveDeps.mcpEnabled} tools=${tools.length}`
  );

  if (!effectiveDeps.mcpEnabled || tools.length === 0) {
    const { content } = await effectiveDeps.llamaChatCompletion(baseUrl, messages, opts, []);
    return content ?? "";
  }

  const currentMessages = messages.map((message) => ({ ...message }));
  const lastMessage = currentMessages[currentMessages.length - 1];
  if (
    currentMessages.length <= 2 &&
    lastMessage?.role === "user" &&
    typeof lastMessage.content === "string" &&
    !lastMessage.content.includes(TOOL_CALL_FORMAT_REMINDER)
  ) {
    currentMessages[currentMessages.length - 1] = {
      ...lastMessage,
      content: `${lastMessage.content}\n\n${TOOL_CALL_FORMAT_REMINDER}`,
    };
  }
  const sourceUrls = new Set();
  let stallingInjected = false;
  let docsSearchAttempted = false;
  let groundedDocsFound = false;
  let docsToolFallbackInjected = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { content, tool_calls } = await effectiveDeps.llamaChatCompletion(baseUrl, currentMessages, opts, tools);

    effectiveDeps.logger.debug(`[tool-call] round=${round + 1} tool_calls=${tool_calls?.length ?? 0}`);

    if (!tool_calls || tool_calls.length === 0) {
      if (content && MALFORMED_TOOL_CALL_RE.test(content)) {
        effectiveDeps.logger.warn(
          `[tool-call] round=${round + 1} detected malformed tool call syntax in content — injecting format reminder`
        );
        currentMessages.push({ role: "assistant", content: content ?? null });
        currentMessages.push({
          role: "user",
          content:
            "You must use the tools by calling them through the function calling API, not by writing 'call toolname'. Please make a proper tool call now.",
        });
        continue;
      }

      if (!stallingInjected && looksLikeStalling(content)) {
        effectiveDeps.logger.debug(`[tool-call] round=${round + 1} stalling detected — injecting tool reminder`);
        stallingInjected = true;
        currentMessages.push({ role: "assistant", content: content ?? null });
        currentMessages.push({
          role: "user",
          content: "Please call the appropriate tool now to get the information.",
        });
        continue;
      }

      if (docsSearchAttempted && !groundedDocsFound) {
        if (docsToolFallbackInjected) {
          return appendToolSourcesToFinalResponse(content, sourceUrls);
        }
        effectiveDeps.logger.warn(
          `[tool-call] round=${round + 1} finalizing without grounded docs evidence after fallback attempts`
        );
        return DOC_NO_RESULTS_MESSAGE;
      }

      return appendToolSourcesToFinalResponse(content, sourceUrls);
    }

    currentMessages.push({
      role: "assistant",
      content: content ?? null,
      tool_calls,
    });

    for (const tc of tool_calls) {
      let args;
      let toolOutcome;

      try {
        args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : (tc.function.arguments ?? {});
      } catch (err) {
        const safeMessage = sanitizeToolErrorMessage(err);
        effectiveDeps.logger.warn(`[tool-call] Tool ${tc.function.name} args parse failed: ${safeMessage}`);
        const result = buildToolFailureResult(tc.function.name, `argument_parse_error: ${safeMessage}`);
        toolOutcome = {
          result,
          grounded: false,
          sourceUrls: [],
          docsSearchAttempted: isDocsSearchTool(tc.function.name),
        };
      }

      if (!toolOutcome) {
        try {
          toolOutcome = await executeToolCallWithFallback(tc.function.name, args, {
            tools,
            callMcpTool: effectiveDeps.callMcpTool,
            logger: effectiveDeps.logger,
          });
        } catch (err) {
          const safeMessage = sanitizeToolErrorMessage(err);
          effectiveDeps.logger.warn(`[tool-call] Tool ${tc.function.name} failed: ${safeMessage}`);
          toolOutcome = {
            result: buildToolFailureResult(tc.function.name, `execution_error: ${safeMessage}`),
            grounded: false,
            sourceUrls: [],
            docsSearchAttempted: isDocsSearchTool(tc.function.name),
          };
        }
      }

      for (const sourceUrl of toolOutcome.sourceUrls ?? []) {
        sourceUrls.add(sourceUrl);
        effectiveDeps.logger.debug(`[tool-call] collected sourceUrl: ${sourceUrl}`);
      }
      if (toolOutcome.docsSearchAttempted) {
        docsSearchAttempted = true;
        groundedDocsFound ||= toolOutcome.grounded;
      }

      currentMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: serializeToolResult(toolOutcome.result, effectiveDeps.logger),
      });
    }

    if (docsSearchAttempted && !groundedDocsFound && !docsToolFallbackInjected) {
      const hasExecError = tool_calls.some((tc) => {
        if (!isDocsSearchTool(tc.function.name)) return false;
        const msg = currentMessages.findLast(
          (m) => m.role === "tool" && m.tool_call_id === tc.id
        );
        if (!msg) return false;
        try {
          const envelope = JSON.parse(msg.content);
          return !envelope.ok && !envelope.empty;
        } catch {
          return false;
        }
      });
      if (hasExecError) {
        effectiveDeps.logger.warn(`[tool-call] docs tool execution error detected — injecting memory fallback`);
        docsToolFallbackInjected = true;
        currentMessages.push({ role: "user", content: DOC_TOOL_UNAVAILABLE_FALLBACK });
      }
    }

  }

  effectiveDeps.logger.warn(`[tool-call] Exceeded MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) — calling without tools`);
  if (docsSearchAttempted && !groundedDocsFound && !docsToolFallbackInjected) {
    return DOC_NO_RESULTS_MESSAGE;
  }
  const { content } = await effectiveDeps.llamaChatCompletion(baseUrl, currentMessages, opts, []);
  return appendToolSourcesToFinalResponse(content, sourceUrls);
}

/**
 * @param {string} baseUrl
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function llamaWithTools(baseUrl, messages, opts = {}) {
  return llamaWithToolsInternal(baseUrl, messages, opts);
}
