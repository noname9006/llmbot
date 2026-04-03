import { config } from "../config.js";
import { logger } from "../logger.js";

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

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`SearXNG returned ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
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
