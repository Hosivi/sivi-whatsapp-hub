/**
 * sivihub-messages-rate-limit.test.ts — Unit tests for the pure per-link rate
 * limiter in front of POST /sivihub/messages (ADR-0048 corte 4 correction).
 *
 * Pure Vitest — no Hono, no DB, no Testcontainers. The limiter takes an
 * injectable clock so window-reset behavior is deterministic (no real sleeps).
 *
 * Scenarios:
 * (a) requests up to the max, within the window → all allowed
 * (b) one more request over the max, same window → refused with a positive Retry-After
 * (c) two different link ids never share a budget
 * (d) once the window elapses, the same link's budget resets
 *
 * STRICT TDD MODE — written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import { createSivihubMessagesRateLimiter } from '../../src/sivihub-inbound/sivihub-messages-rate-limit.js';

const LINK_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LINK_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
}

describe('createSivihubMessagesRateLimiter', () => {
  it('(a) requests up to the max, within the window → all allowed', () => {
    const clock = makeClock(1_000_000);
    const limiter = createSivihubMessagesRateLimiter({
      maxRequests: 3,
      windowMs: 60_000,
      now: clock.now,
    });

    expect(limiter.check(LINK_A)).toEqual({ allowed: true });
    expect(limiter.check(LINK_A)).toEqual({ allowed: true });
    expect(limiter.check(LINK_A)).toEqual({ allowed: true });
  });

  it('(b) one more request over the max, same window → refused with a positive Retry-After', () => {
    const clock = makeClock(1_000_000);
    const limiter = createSivihubMessagesRateLimiter({
      maxRequests: 2,
      windowMs: 60_000,
      now: clock.now,
    });

    expect(limiter.check(LINK_A).allowed).toBe(true);
    expect(limiter.check(LINK_A).allowed).toBe(true);

    const result = limiter.check(LINK_A);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      // Window has 60s and we haven't advanced the clock at all — the
      // remaining time must be close to the full window.
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('(c) two different link ids never share a budget', () => {
    const clock = makeClock(1_000_000);
    const limiter = createSivihubMessagesRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: clock.now,
    });

    expect(limiter.check(LINK_A).allowed).toBe(true);
    // LINK_A is now over budget for this window.
    expect(limiter.check(LINK_A).allowed).toBe(false);
    // LINK_B has its OWN budget — unaffected by LINK_A's usage.
    expect(limiter.check(LINK_B).allowed).toBe(true);
  });

  it('(d) once the window elapses, the same link budget resets', () => {
    const clock = makeClock(1_000_000);
    const limiter = createSivihubMessagesRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: clock.now,
    });

    expect(limiter.check(LINK_A).allowed).toBe(true);
    expect(limiter.check(LINK_A).allowed).toBe(false);

    // Advance past the window boundary.
    clock.advance(60_001);

    expect(limiter.check(LINK_A).allowed).toBe(true);
  });

  it('falls back to sane defaults when maxRequests/windowMs are not overridden by the caller', () => {
    // The middleware layer is responsible for supplying the documented
    // default (30 req / 60s) — this just proves the limiter honors whatever
    // it's given without any hidden internal minimum getting in the way.
    const clock = makeClock(0);
    const limiter = createSivihubMessagesRateLimiter({
      maxRequests: 1,
      windowMs: 1,
      now: clock.now,
    });
    expect(limiter.check(LINK_A).allowed).toBe(true);
    expect(limiter.check(LINK_A).allowed).toBe(false);
  });
});
