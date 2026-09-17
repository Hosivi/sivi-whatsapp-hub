/**
 * sivihub-messages-rate-limit.ts — pure per-link rate limiter in front of
 * POST /sivihub/messages (ADR-0048 corte 4 correction).
 *
 * A leaked link secret, or a retry bug on the SiviHub side, could otherwise
 * flood real WhatsApp sends — real money (Meta conversation pricing) and WABA
 * reputation. This is a simple in-process, fixed-window counter keyed by the
 * link id: in-process is fine at this repo's scale (single-VPS, "no Redis,
 * deliberately" — see CLAUDE.md). A process restart resets all counters; that
 * is acceptable for a flood guard, not a hard SLA.
 *
 * DEFAULT: 30 requests / 60 seconds per link (see the middleware for where
 * this default is applied) — generous for a human operator replying through
 * the CRM, tight enough to catch a leaked secret or a retry-storm bug before
 * it burns real sends. Configurable via SIVIHUB_MESSAGES_RATE_LIMIT_MAX and
 * SIVIHUB_MESSAGES_RATE_LIMIT_WINDOW_MS.
 *
 * Pure — no I/O, no Hono, no clock reads except through the injectable `now`
 * (defaults to Date.now), so it is unit-testable without real sleeps.
 */

export type RateLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export type SivihubMessagesRateLimiter = {
  /** Checks AND consumes one unit of the link's budget for the current window. */
  check(linkId: string): RateLimitResult;
};

export type CreateSivihubMessagesRateLimiterOptions = {
  readonly maxRequests: number;
  readonly windowMs: number;
  /** Injected clock (ms since epoch) — defaults to Date.now. */
  readonly now?: () => number;
};

type WindowState = {
  count: number;
  windowStartMs: number;
};

export function createSivihubMessagesRateLimiter(
  options: CreateSivihubMessagesRateLimiterOptions,
): SivihubMessagesRateLimiter {
  const { maxRequests, windowMs } = options;
  const now = options.now ?? Date.now;
  // Keyed by linkId — a fixed-window counter per link. Never pruned: at this
  // repo's scale (one Hub instance, a handful of tenants/links), the map stays
  // small; a periodic sweep can be added later if link churn ever makes it worth it.
  const windows = new Map<string, WindowState>();

  return {
    check(linkId: string): RateLimitResult {
      const nowMs = now();
      const state = windows.get(linkId);

      if (!state || nowMs - state.windowStartMs >= windowMs) {
        // First request for this link, or the previous window has elapsed —
        // start a fresh window.
        windows.set(linkId, { count: 1, windowStartMs: nowMs });
        return { allowed: true };
      }

      if (state.count < maxRequests) {
        state.count++;
        return { allowed: true };
      }

      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((state.windowStartMs + windowMs - nowMs) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    },
  };
}
