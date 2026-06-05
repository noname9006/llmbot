import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// config requires a remote token to load
process.env.DISCORD_TOKEN_REMOTE ??= "test-token";

// backendRouter reads the shared, mutable `config` singleton at call time, so
// tests drive scenarios by mutating it directly (no module-cache busting needed).
const { config } = await import("../src/config.js");
const { resolveBackends, runWithFallback, modelOpts } = await import(
  "../src/services/backendRouter.js"
);

const OR_PARAMS = { temperature: 0.5, topP: 0.9, topK: 30, maxTokens: 256 };

function roleCfg(overrides = {}) {
  return {
    enabled: true,
    priority: "llama",
    model: "org/model:free",
    contextSize: 8192,
    fetchTimeoutMs: 99000,
    params: { ...OR_PARAMS },
    ...overrides,
  };
}

beforeEach(() => {
  // Known clean state: both roles OpenRouter-enabled with a key, llama URLs set.
  config.llama.remoteUrl = "http://remote:8080/v1";
  config.llama.localUrl = "http://local:8081/v1";
  config.openrouter.apiKey = "test-key";
  config.openrouter.baseUrl = "https://openrouter.ai/api/v1";
  config.openrouter.referer = "";
  config.openrouter.title = "";
  config.openrouter.fallback = 0; // default: no cross-role fallback
  config.openrouter.remote = roleCfg({ model: "remote/model:free" });
  config.openrouter.local = roleCfg({ model: "local/model:free" });
});

// ── modelOpts — OpenRouter shaping ───────────────────────────────────────────

describe("modelOpts — OpenRouter shaping", () => {
  test("includes provider/model/apiKey and the OpenAI-safe param subset", () => {
    const opts = modelOpts("remote", "openrouter");
    assert.equal(opts.provider, "openrouter");
    assert.equal(opts.model, "remote/model:free");
    assert.equal(opts.apiKey, "test-key");
    assert.equal(opts.temperature, 0.5);
    assert.equal(opts.top_p, 0.9);
    assert.equal(opts.top_k, 30);
    assert.equal(opts.max_tokens, 256);
    assert.equal(opts.contextSize, 8192);
    assert.equal(opts.fetchTimeout, 99000);
  });

  test("never sends llama.cpp-only fields", () => {
    const opts = modelOpts("local", "openrouter");
    for (const key of ["n_keep", "min_p", "repeat_penalty", "budget_tokens"]) {
      assert.equal(key in opts, false, `${key} must not be present`);
    }
  });

  test("omits max_tokens when not positive (never sends -1 to OpenRouter)", () => {
    config.openrouter.remote = roleCfg({ params: { ...OR_PARAMS, maxTokens: 0 } });
    const opts = modelOpts("remote", "openrouter");
    assert.equal("max_tokens" in opts, false);
  });
});

// ── modelOpts — llama path unchanged ─────────────────────────────────────────

describe("modelOpts — llama path unchanged", () => {
  test("tags provider llama and keeps llama.cpp params; no model/apiKey", () => {
    const opts = modelOpts("remote", "llama");
    assert.equal(opts.provider, "llama");
    assert.equal("repeat_penalty" in opts, true);
    assert.equal("min_p" in opts, true);
    assert.equal("model" in opts, false);
    assert.equal("apiKey" in opts, false);
  });

  test("defaults to the llama path when provider is omitted", () => {
    assert.equal(modelOpts("local").provider, "llama");
  });
});

// ── resolveBackends — ordering & gating (FALLBACK=0) ─────────────────────────

describe("resolveBackends — ordering & gating (fallback=0)", () => {
  test("priority=llama → [llama, openrouter]", () => {
    config.openrouter.remote = roleCfg({ priority: "llama" });
    const eps = resolveBackends("remote");
    assert.deepEqual(eps.map((e) => e.provider), ["llama", "openrouter"]);
    assert.equal(eps[0].baseUrl, "http://remote:8080/v1");
    assert.equal(eps[1].baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(eps[1].opts.provider, "openrouter");
  });

  test("priority=openrouter → [openrouter, llama]", () => {
    config.openrouter.remote = roleCfg({ priority: "openrouter" });
    const eps = resolveBackends("remote");
    assert.deepEqual(eps.map((e) => e.provider), ["openrouter", "llama"]);
  });

  test("no API key ⇒ OpenRouter is dropped", () => {
    config.openrouter.apiKey = "";
    const eps = resolveBackends("remote");
    assert.deepEqual(eps.map((e) => e.provider), ["llama"]);
  });

  test("role disabled ⇒ OpenRouter is dropped", () => {
    config.openrouter.local = roleCfg({ enabled: false });
    const eps = resolveBackends("local");
    assert.deepEqual(eps.map((e) => e.provider), ["llama"]);
  });

  test("missing llama URL ⇒ only OpenRouter remains", () => {
    config.llama.localUrl = "";
    config.openrouter.local = roleCfg({ priority: "llama" });
    const eps = resolveBackends("local");
    assert.deepEqual(eps.map((e) => e.provider), ["openrouter"]);
  });

  test("all endpoints have nativeRole equal to the requested role (no cross-role)", () => {
    config.openrouter.remote = roleCfg({ priority: "openrouter" });
    for (const ep of resolveBackends("remote")) {
      assert.equal(ep.nativeRole, "remote");
    }
  });
});

// ── resolveBackends — cross-role fallback (FALLBACK=1) ───────────────────────

describe("resolveBackends — FALLBACK=1 (local→remote only)", () => {
  beforeEach(() => {
    config.openrouter.fallback = 1;
  });

  test("local role gets cross-role remote OR after primary local OR", () => {
    config.openrouter.local = roleCfg({ priority: "openrouter" });
    const eps = resolveBackends("local");
    // [local-OR, remote-OR (cross), llama-local]
    // Cross-role uses the remote model config but keeps nativeRole=local so
    // the requesting role's system prompt is preserved.
    const providers = eps.map((e) => e.provider);
    const nativeRoles = eps.map((e) => e.nativeRole);
    assert.deepEqual(providers, ["openrouter", "openrouter", "llama"]);
    assert.deepEqual(nativeRoles, ["local", "local", "local"]);
    // The cross-role endpoint still uses the OTHER role's model slug.
    assert.equal(eps[1].opts.model, config.openrouter.remote.model);
  });

  test("remote role does NOT get cross-role local OR (no upgrade in mode 1)", () => {
    config.openrouter.remote = roleCfg({ priority: "openrouter" });
    const eps = resolveBackends("remote");
    // [remote-OR, llama-remote] — no local OR cross-role
    assert.equal(eps.length, 2);
    assert.deepEqual(eps.map((e) => e.provider), ["openrouter", "llama"]);
    assert.deepEqual(eps.map((e) => e.nativeRole), ["remote", "remote"]);
  });

  test("no cross-role if primary OR is not configured for local", () => {
    config.openrouter.local = roleCfg({ enabled: false }); // primary OR off
    const eps = resolveBackends("local");
    // Only llama remains; no cross-role because primary OR never existed
    assert.deepEqual(eps.map((e) => e.provider), ["llama"]);
  });

  test("cross-role is skipped if the other OR role is also not a candidate", () => {
    config.openrouter.local = roleCfg({ priority: "openrouter" });
    config.openrouter.remote = roleCfg({ enabled: false }); // remote OR off
    const eps = resolveBackends("local");
    // [local-OR, llama-local] — remote OR is not a candidate so no cross-role
    assert.deepEqual(eps.map((e) => e.provider), ["openrouter", "llama"]);
    assert.deepEqual(eps.map((e) => e.nativeRole), ["local", "local"]);
  });
});

// ── resolveBackends — cross-role fallback (FALLBACK=2) ───────────────────────

describe("resolveBackends — FALLBACK=2 (any direction)", () => {
  beforeEach(() => {
    config.openrouter.fallback = 2;
  });

  test("local role: [local-OR, remote-OR (cross), llama]", () => {
    config.openrouter.local = roleCfg({ priority: "openrouter" });
    const eps = resolveBackends("local");
    assert.deepEqual(eps.map((e) => e.provider), ["openrouter", "openrouter", "llama"]);
    // Cross-role endpoint keeps nativeRole=local so the local system prompt is preserved.
    assert.deepEqual(eps.map((e) => e.nativeRole), ["local", "local", "local"]);
    assert.equal(eps[1].opts.model, config.openrouter.remote.model);
  });

  test("remote role: [remote-OR, local-OR (cross), llama]", () => {
    config.openrouter.remote = roleCfg({ priority: "openrouter" });
    const eps = resolveBackends("remote");
    assert.deepEqual(eps.map((e) => e.provider), ["openrouter", "openrouter", "llama"]);
    // Cross-role endpoint keeps nativeRole=remote so the remote system prompt is preserved.
    assert.deepEqual(eps.map((e) => e.nativeRole), ["remote", "remote", "remote"]);
    assert.equal(eps[1].opts.model, config.openrouter.local.model);
  });

  test("cross-role OR uses the other role's model/opts", () => {
    config.openrouter.remote = roleCfg({ priority: "openrouter", model: "remote-model:free" });
    config.openrouter.local  = roleCfg({ model: "local-model:free" });
    const eps = resolveBackends("remote");
    // primary OR = remote model; cross-role = local model
    assert.equal(eps[0].opts.model, "remote-model:free");
    assert.equal(eps[1].opts.model, "local-model:free");
  });
});

// ── runWithFallback ───────────────────────────────────────────────────────────

describe("runWithFallback", () => {
  test("falls through to the next backend when the first throws", async () => {
    config.openrouter.remote = roleCfg({ priority: "openrouter" });
    const seen = [];
    const result = await runWithFallback("remote", async (ep) => {
      seen.push(ep.provider);
      if (ep.provider === "openrouter") throw new Error("boom");
      return `ok:${ep.provider}`;
    });
    assert.deepEqual(seen, ["openrouter", "llama"]);
    assert.equal(result, "ok:llama");
  });

  test("rethrows the last error when every backend fails", async () => {
    await assert.rejects(
      runWithFallback("remote", async (ep) => {
        throw new Error(`fail:${ep.provider}`);
      }),
      /fail:openrouter|fail:llama/
    );
  });

  test("throws when no backend is configured", async () => {
    config.llama.remoteUrl = "";
    config.openrouter.apiKey = "";
    await assert.rejects(
      runWithFallback("remote", async () => "unreachable"),
      /No inference backend configured/
    );
  });

  test("returns the first backend's result without trying the fallback", async () => {
    config.openrouter.remote = roleCfg({ priority: "llama" });
    const seen = [];
    const result = await runWithFallback("remote", async (ep) => {
      seen.push(ep.provider);
      return `ok:${ep.provider}`;
    });
    assert.deepEqual(seen, ["llama"]);
    assert.equal(result, "ok:llama");
  });

  test("runner receives the requestedRole as second argument", async () => {
    config.openrouter.remote = roleCfg({ priority: "openrouter" });
    let receivedRole;
    await runWithFallback("remote", async (ep, role) => {
      receivedRole = role;
      return "ok";
    });
    assert.equal(receivedRole, "remote");
  });

  test("cross-role fallback: nativeRole is preserved as the requesting role", async () => {
    config.openrouter.fallback = 2;
    config.openrouter.remote = roleCfg({ priority: "openrouter" });
    const nativeRoles = [];
    let callCount = 0;
    await runWithFallback("remote", async (ep) => {
      nativeRoles.push(ep.nativeRole);
      callCount++;
      if (callCount <= 2) throw new Error("fail");
      return "ok";
    }).catch(() => {}); // all fail is OK for this test
    // Both OR calls keep nativeRole=remote so the Bitz system prompt is always used.
    assert.deepEqual(nativeRoles.slice(0, 2), ["remote", "remote"]);
  });
});
