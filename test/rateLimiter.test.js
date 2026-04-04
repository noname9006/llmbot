import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createRateLimiter } from "../src/utils/rateLimiter.js";

describe("createRateLimiter", () => {
  describe("check()", () => {
    test("allows requests below the limit", () => {
      const rl = createRateLimiter({ maxRequests: 3, windowMs: 5000 });
      assert.equal(rl.check("u1"), true);
      assert.equal(rl.check("u1"), true);
      assert.equal(rl.check("u1"), true);
    });

    test("blocks the request that would exceed the limit", () => {
      const rl = createRateLimiter({ maxRequests: 2, windowMs: 5000 });
      rl.check("u1");
      rl.check("u1");
      assert.equal(rl.check("u1"), false);
    });

    test("tracks users independently", () => {
      const rl = createRateLimiter({ maxRequests: 1, windowMs: 5000 });
      assert.equal(rl.check("alice"), true);
      assert.equal(rl.check("alice"), false);
      assert.equal(rl.check("bob"), true); // bob is unaffected
    });

    test("allows requests again after the window expires", async () => {
      const rl = createRateLimiter({ maxRequests: 1, windowMs: 50 });
      rl.check("u1"); // fills the window
      assert.equal(rl.check("u1"), false);
      await new Promise((r) => setTimeout(r, 60)); // wait for window to expire
      assert.equal(rl.check("u1"), true);
    });
  });

  describe("retryAfterMs()", () => {
    test("returns 0 when the user is not rate-limited", () => {
      const rl = createRateLimiter({ maxRequests: 3, windowMs: 5000 });
      rl.check("u1");
      assert.equal(rl.retryAfterMs("u1"), 0);
    });

    test("returns a positive number when the user is rate-limited", () => {
      const rl = createRateLimiter({ maxRequests: 1, windowMs: 5000 });
      rl.check("u1");
      const ms = rl.retryAfterMs("u1");
      assert.ok(ms > 0, `expected ms > 0, got ${ms}`);
      assert.ok(ms <= 5000, `expected ms <= windowMs (5000), got ${ms}`);
    });

    test("never returns a negative value", () => {
      const rl = createRateLimiter({ maxRequests: 2, windowMs: 10 });
      rl.check("u1");
      rl.check("u1");
      // Burn a little time so the window is close to expiry
      const end = Date.now() + 15;
      while (Date.now() < end) { /* busy-wait */ }
      const ms = rl.retryAfterMs("u1");
      assert.ok(ms >= 0, `retryAfterMs must never be negative, got ${ms}`);
    });

    test("returns 0 for an unknown user", () => {
      const rl = createRateLimiter({ maxRequests: 3, windowMs: 5000 });
      assert.equal(rl.retryAfterMs("unknown-user"), 0);
    });
  });

  describe("cleanup()", () => {
    test("removes expired entries", async () => {
      const rl = createRateLimiter({ maxRequests: 3, windowMs: 50 });
      rl.check("u1");
      await new Promise((r) => setTimeout(r, 60));
      rl.cleanup();
      // After cleanup the user is no longer limited (window expired)
      assert.equal(rl.retryAfterMs("u1"), 0);
    });
  });
});
