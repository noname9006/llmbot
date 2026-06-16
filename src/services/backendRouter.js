import { config } from "../config.js";
import { logger } from "../logger.js";

// ── Circuit breaker ───────────────────────────────────────────────────────────
// Tracks OpenRouter endpoints that have recently exhausted all retries.
// While the circuit is open (within the cooldown window) the endpoint is skipped
// so callers go straight to the next backend without burning retry time.

const CIRCUIT_OPEN_MS = 60 * 60 * 1000; // 60 minutes
const _circuitOpenUntil = new Map(); // key → timestamp

function circuitKey(ep) {
  return `${ep.provider}:${ep.opts?.model ?? ep.baseUrl ?? "unknown"}`;
}

function isCircuitOpen(ep) {
  const until = _circuitOpenUntil.get(circuitKey(ep));
  if (!until) return false;
  if (Date.now() < until) return true;
  _circuitOpenUntil.delete(circuitKey(ep));
  return false;
}

/**
 * Resets all open circuit breakers. Call when an external health check confirms
 * that a previously-unreachable provider is back online, so requests are retried
 * immediately instead of waiting for the 60-min window to expire.
 */
export function resetAllCircuits() {
  if (_circuitOpenUntil.size > 0) {
    _circuitOpenUntil.clear();
    logger.info("[backend] all circuit breakers reset");
  }
}

function tripCircuit(ep) {
  const key = circuitKey(ep);
  const resetAt = new Date(Date.now() + CIRCUIT_OPEN_MS).toISOString();
  _circuitOpenUntil.set(key, Date.now() + CIRCUIT_OPEN_MS);
  logger.warn(`[backend] circuit tripped for ${key} — will skip until ${resetAt}`);
}

/**
 * Per-role inference backend resolution with automatic fallback.
 *
 * Each role ("remote" | "local") can be serviced by the self-hosted
 * llama-server and/or by OpenRouter.  The role's `priority` decides which
 * provider is tried first; if that provider's call throws, the request
 * automatically falls back to the next provider in the chain.
 *
 * Cross-role OR fallback (OPENROUTER_FALLBACK=1 or 2) can add the OTHER role's
 * OpenRouter endpoint to the chain so a failing OR model automatically retries
 * on the sibling model before giving up and falling back to llama.
 *
 * Provider-specific details (apiKey, model, provider tag, nativeRole) are
 * carried on the returned `opts`/endpoint objects so the existing network layer
 * (llamaChatCompletion) can act on them without any signature changes.
 */

function capRole(role) {
  return role[0].toUpperCase() + role.slice(1); // "Remote" | "Local"
}

/**
 * Builds the llama-server inference opts for a role — identical to the
 * historical messageHandler.modelOpts() output (plus an explicit provider tag).
 * @param {'remote'|'local'} role
 */
function llamaOpts(role) {
  const cap = capRole(role);
  const params = config.llama[`params${cap}`];
  const contextSizeKey = role === "remote" ? "contextSlotSizeRemote" : "contextSlotSizeLocal";
  return {
    provider:       "llama",
    temperature:    params.temperature,
    top_p:          params.topP,
    top_k:          params.topK,
    min_p:          params.minP,
    repeat_penalty: params.repeatPenalty,
    max_tokens:     params.maxTokens > 0 ? params.maxTokens : -1,
    ...(params.reasoningBudget >= 0 ? { budget_tokens: params.reasoningBudget } : {}),
    fetchTimeout:   config.llama[`fetchTimeout${cap}`],
    contextSize:    config.llama[contextSizeKey],
  };
}

/**
 * Builds the OpenRouter inference opts for a given config-role (the role
 * whose OPENROUTER_*_* env vars are used).  Only the OpenAI/OpenRouter-safe
 * param subset is included; max_tokens is omitted when not positive (never
 * send -1 to OpenRouter).  No n_keep / min_p / repeat_penalty / budget_tokens.
 * @param {'remote'|'local'} configRole
 */
function openrouterOpts(configRole) {
  const roleCfg = config.openrouter[configRole];
  const p = roleCfg.params;
  return {
    provider:     "openrouter",
    apiKey:       config.openrouter.apiKey,
    model:        roleCfg.model,
    temperature:  p.temperature,
    top_p:        p.topP,
    top_k:        p.topK,
    ...(p.maxTokens > 0 ? { max_tokens: p.maxTokens } : {}),
    fetchTimeout: roleCfg.fetchTimeoutMs,
    contextSize:  roleCfg.contextSize,
  };
}

/**
 * Returns the inference opts for a role + provider.
 * @param {'remote'|'local'} role
 * @param {'llama'|'openrouter'} [provider]
 */
export function modelOpts(role, provider = "llama") {
  return provider === "openrouter" ? openrouterOpts(role) : llamaOpts(role);
}

/**
 * A role is an OpenRouter candidate only when its per-role flag is enabled and
 * a shared API key is configured.
 * @param {'remote'|'local'} role
 */
export function isOpenrouterCandidate(role) {
  return Boolean(config.openrouter?.[role]?.enabled && config.openrouter?.apiKey);
}

/**
 * Builds a single OR endpoint descriptor for the given configRole.
 * Returns null when that role is not an OR candidate.
 *
 * @param {'remote'|'local'} configRole  - which OR config to use
 * @param {'remote'|'local'} nativeRole  - which role "owns" this endpoint for
 *                                         system-prompt selection (may differ
 *                                         from configRole on cross-role fallback)
 * @returns {object|null}
 */
function buildOrEndpoint(configRole, nativeRole) {
  if (!isOpenrouterCandidate(configRole)) return null;
  return {
    provider:    "openrouter",
    baseUrl:     config.openrouter.baseUrl,
    nativeRole,  // tells the handler which system prompt to use
    opts:        openrouterOpts(configRole),
  };
}

/**
 * Resolves the ordered list of backend endpoints to try for a role.
 *
 * Each endpoint: { provider, baseUrl, nativeRole, opts }
 *   - provider:    "llama" | "openrouter"
 *   - baseUrl:     the URL to POST /chat/completions to
 *   - nativeRole:  which role's system prompt the handler should use
 *   - opts:        provider-shaped inference params
 *
 * Ordering follows the role's `priority` setting.  Cross-role OR endpoints
 * are inserted just after the primary OR endpoint (before falling back to
 * llama) when OPENROUTER_FALLBACK allows it.
 *
 * @param {'remote'|'local'} role
 * @returns {Array<{provider: string, baseUrl: string, nativeRole: string, opts: object}>}
 */
export function resolveBackends(role) {
  const otherRole   = role === "local" ? "remote" : "local";
  const llamaUrl    = role === "remote" ? config.llama.remoteUrl : config.llama.localUrl;
  const fallbackMode = Math.max(0, Math.min(2, Number(config.openrouter?.fallback ?? 0)));

  // llama endpoint for this role
  const llamaEp = llamaUrl
    ? { provider: "llama", baseUrl: llamaUrl, nativeRole: role, opts: modelOpts(role, "llama") }
    : null;

  // Primary OR endpoint (this role's own OR config)
  const orPrimary = buildOrEndpoint(role, role);

  // Cross-role OR fallback endpoint — only meaningful when primary OR exists:
  //   mode 1: only local → remote (downgrade to lighter model)
  //   mode 2: any direction
  let orCrossRole = null;
  if (orPrimary && fallbackMode > 0) {
    const crossAllowed = fallbackMode === 2 || (fallbackMode === 1 && role === "local");
    if (crossAllowed) {
      // Cross-role endpoint: use the OTHER role's OR model config (different
      // model slug / params) but keep nativeRole = role so buildMessagesForEndpoint
      // preserves the requesting role's system prompt.  Vale's prompt must only
      // appear when there is an explicit escalation, not on a transparent fallback.
      orCrossRole = buildOrEndpoint(otherRole, role);
    }
  }

  const priority = config.openrouter?.[role]?.priority ?? "llama";

  // Build the ordered chain: OR-first or llama-first.
  // Cross-role OR comes immediately after primary OR so the entire OR tier is
  // exhausted before falling back to the self-hosted llama-server.
  if (priority === "openrouter") {
    return [orPrimary, orCrossRole, llamaEp].filter(Boolean);
  }
  return [llamaEp, orPrimary, orCrossRole].filter(Boolean);
}

/**
 * Runs `runner(endpoint, requestedRole)` against the role's preferred backend,
 * falling back to the next backend in the chain if the call throws.
 * Rethrows the last error when every backend fails.
 *
 * The runner receives:
 *   - endpoint: { provider, baseUrl, nativeRole, opts }
 *   - requestedRole: the role string originally passed to runWithFallback
 *
 * The runner is expected to perform a single self-contained inference flow
 * (e.g. one llamaWithTools call) with no external side effects, so a fallback
 * retry cannot duplicate user-visible output.
 *
 * @template T
 * @param {'remote'|'local'} role
 * @param {(endpoint: object, requestedRole: string) => Promise<T>} runner
 * @returns {Promise<T>}
 */
export async function runWithFallback(role, runner) {
  const backends = resolveBackends(role);
  if (backends.length === 0) {
    throw new Error(`No inference backend configured for role "${role}"`);
  }

  let lastErr;
  for (let i = 0; i < backends.length; i++) {
    const ep = backends[i];

    // Skip endpoints whose circuit is open (exhausted all retries recently).
    if (isCircuitOpen(ep)) {
      const key = circuitKey(ep);
      const next = backends.slice(i + 1).find((b) => !isCircuitOpen(b));
      logger.warn(
        `[backend] role=${role} skipping ${key} (circuit open) — ` +
          (next ? `next: ${circuitKey(next)}` : "no further backend available")
      );
      if (!next) break; // will throw lastErr below
      continue;
    }

    try {
      return await runner(ep, role);
    } catch (err) {
      lastErr = err;

      // Trip the circuit for OpenRouter endpoints so the next request skips
      // the 3×10 s retry wait and goes straight to the next backend.
      if (ep.provider === "openrouter") {
        tripCircuit(ep);
      }

      const next = backends.slice(i + 1).find((b) => !isCircuitOpen(b));
      if (next) {
        logger.warn(
          `[backend] role=${role} provider=${ep.provider}${ep.nativeRole !== role ? `(native=${ep.nativeRole})` : ""} failed (${err.message}) — falling back to ${next.provider}${next.nativeRole !== role ? `(native=${next.nativeRole})` : ""}`
        );
      } else {
        logger.warn(
          `[backend] role=${role} provider=${ep.provider}${ep.nativeRole !== role ? `(native=${ep.nativeRole})` : ""} failed (${err.message}) — no further fallback`
        );
      }
    }
  }
  throw lastErr ?? new Error(`No available inference backend for role "${role}"`);
}
