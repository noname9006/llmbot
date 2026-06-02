/**
 * Sends a minimal inference request to warm up the model after it loads.
 * Non-fatal: logs a warning on failure but does not throw.
 *
 * @param {number} port
 * @param {{ fetchImpl?: typeof fetch, logger?: { info: Function, warn: Function } }} [options]
 * @returns {Promise<void>}
 */
export async function warmupModel(port, { fetchImpl = fetch, logger = console } = {}) {
  try {
    logger.info("Warming up model (sending minimal inference request)...");
    const res = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (res.ok) {
      logger.info("Model warmup complete");
    } else {
      const text = await res.text().catch(() => "(unreadable)");
      logger.warn(`Model warmup returned non-OK status ${res.status}: ${text}`);
    }
  } catch (err) {
    logger.warn(`Model warmup failed (non-fatal): ${err.message}`);
  }
}
