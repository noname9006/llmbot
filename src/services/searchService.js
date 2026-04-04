import { config } from "../config.js";
import { logger } from "../logger.js";
import { withRetry } from "../utils/retry.js";

/**
 * Queries SearXNG for the given search term and returns a formatted string
 * of the top N results (title + snippet).
 *
 * @param {string} query
 * @returns {Promise<string>}  formatted results block ready to inject into LLM context
 */
export async function search(query) {
  const searxngBaseUrl = config.search.searxngBaseUrl;
  if (!searxngBaseUrl) {
    throw new Error("SEARXNG_BASE_URL is not configured");
  }

  const url = new URL("/search", searxngBaseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");

  logger.debug(`SearXNG query: ${url}`);

  const data = await withRetry(
    async () => {
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const err = new Error(`SearXNG returned ${res.status} ${res.statusText}`);
        err.statusCode = res.status;
        throw err;
      }
      return res.json();
    },
    {
      maxAttempts: config.retry.maxAttempts,
      initialDelayMs: config.retry.initialDelayMs,
      label: "SearXNG search",
      shouldRetry: (err) => !err.statusCode || err.statusCode >= 500,
    }
  );

  const results = (data.results ?? []).slice(0, config.search.resultCount);

  if (results.length === 0) {
    return `[Search results for "${query}":\nNo results found.]`;
  }

  const lines = results.map((r, i) => {
    const snippet = r.content ?? r.url ?? "";
    return `${i + 1}. ${r.title ?? "(no title)"}: ${snippet}`;
  });

  return `[Search results for "${query}":\n${lines.join("\n")}]`;
}
