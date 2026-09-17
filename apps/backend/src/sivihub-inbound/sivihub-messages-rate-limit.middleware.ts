/**
 * sivihub-messages-rate-limit.middleware.ts — per-link rate limit mounted in
 * front of POST /sivihub/messages, ahead of S1 (ADR-0048 corte 4 correction).
 *
 * Keyed by the RAW X-Sivi-Link-Id header value — cheaper than waiting for S1
 * to authenticate the link (no DB round trip), and rate-limiting an unknown
 * or malformed link id is harmless: it would fail S1's own auth anyway, so
 * budgeting it costs nothing real. A missing header is NOT this middleware's
 * concern — it lets the request through so S1 can answer its own 401.
 *
 * One limiter instance is created ONCE per app build (closed over here, not
 * per-request) so its counters persist across requests for the lifetime of
 * the process — see sivihub-messages-rate-limit.ts for the counting logic.
 *
 * Over the limit → 429 { error: 'RATE_LIMITED' } with a Retry-After header
 * (seconds). DEFAULT: 30 requests / 60s per link — see
 * sivihub-messages-rate-limit.ts for the rationale. Configurable via
 * SIVIHUB_MESSAGES_RATE_LIMIT_MAX / SIVIHUB_MESSAGES_RATE_LIMIT_WINDOW_MS;
 * env.ts leaves these optional so the `??` fallback below also covers
 * hand-built Env objects in tests that predate these fields.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppDeps } from '../app.js';
import { SIVIHUB_LINK_ID_HEADER } from './sivihub-inbound-signature.js';
import { createSivihubMessagesRateLimiter } from './sivihub-messages-rate-limit.js';

const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_MS = 60_000;

export const createSivihubMessagesRateLimitMiddleware = (deps: AppDeps): MiddlewareHandler => {
  const limiter = createSivihubMessagesRateLimiter({
    maxRequests: deps.env.SIVIHUB_MESSAGES_RATE_LIMIT_MAX ?? DEFAULT_MAX_REQUESTS,
    windowMs: deps.env.SIVIHUB_MESSAGES_RATE_LIMIT_WINDOW_MS ?? DEFAULT_WINDOW_MS,
  });

  return async (c, next) => {
    const linkId = c.req.header(SIVIHUB_LINK_ID_HEADER);
    if (!linkId) {
      // No link id header — not this middleware's concern; let S1 answer.
      await next();
      return;
    }

    const result = limiter.check(linkId);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }

    await next();
    return;
  };
};
