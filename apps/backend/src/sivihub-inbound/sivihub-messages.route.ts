/**
 * sivihub-messages.route.ts — S2: POST /sivihub/messages, the authenticated
 * SiviHub reply route (ADR-0048 corte 4).
 *
 * Behind S1 (createSivihubInboundAuthMiddleware) — NOT the tenant middleware.
 * Body: { to, text }, strict Zod (rejects unknown fields). Reads the raw body
 * S1 already consumed from context (sivihubRawBody) rather than calling
 * c.req.json() again — Hono only lets the request stream be read once.
 *
 * Delegates to the SAME sendWhatsappText service the manual /whatsapp-send
 * route uses, with author: 'agent' — so the outbox still emits message.sent
 * exactly as it does for a manual send (spec: "el envío manual... pasa 'agent'").
 *
 * Success: 200 { wamid, sentAt } where sentAt is EXACTLY the value stored on
 * the message row (its received_at) — sourced from SendOk.sentAt, never a
 * fresh clock read (ADR-0048 corte 4 decision 2).
 *
 * Errors reuse sendErrorToHttpStatus — including WINDOW_CLOSED (422), the
 * distinct, stable code Meta's 24h-window rejection (metaCode 131047) already
 * maps to in whatsapp-send.errors.ts. DB_ERROR is surfaced as a generic
 * INTERNAL_ERROR — never leak cause. Mirrors whatsapp-send.route.ts.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { sendErrorToHttpStatus } from '../whatsapp-send/whatsapp-send.errors.js';
import { sendWhatsappText } from '../whatsapp-send/whatsapp-send.service.js';
import { createSivihubInboundAuthMiddleware } from './sivihub-inbound-auth.middleware.js';
import type { SivihubInboundVariables } from './sivihub-inbound-auth.middleware.js';

// ---------------------------------------------------------------------------
// Body schema — strict: unknown fields are rejected, not silently dropped.
// ---------------------------------------------------------------------------

const bodySchema = z
  .object({
    // E.164 pattern: + followed by country code and subscriber number (7-15 digits total).
    to: z.string().regex(/^\+[1-9]\d{1,14}$/, 'must be a valid E.164 phone number (+XXXXXXXXXXX)'),
    text: z.string().min(1, 'text must not be empty'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export const createSivihubMessagesRoute = (
  deps: AppDeps,
): Hono<{ Variables: SivihubInboundVariables }> => {
  const router = new Hono<{ Variables: SivihubInboundVariables }>();

  // S1 — service auth. NOT createTenantMiddleware: this route has no X-Tenant-Id;
  // the tenant is resolved from the link inside S1.
  router.use('*', createSivihubInboundAuthMiddleware(deps));

  router.post('/', async (c) => {
    // The raw body was already consumed by S1 (arrayBuffer, for signature
    // verification) — read it back from context instead of c.req.json().
    const rawBody = c.get('sivihubRawBody');

    let parsedJson: unknown;
    try {
      parsedJson = rawBody === '' ? undefined : JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 422);
    }

    const parsed = bodySchema.safeParse(parsedJson);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.issues }, 422);
    }

    const tenantId = c.get('tenantId');
    // Every SiviHub-initiated reply is a human operator acting from the CRM —
    // author is always 'agent', never taken from the request body (mirrors the
    // manual /whatsapp-send route's own rule).
    const result = await sendWhatsappText(deps, tenantId, { ...parsed.data, author: 'agent' });

    if (!result.ok) {
      const status = sendErrorToHttpStatus(result.error);
      // DB_ERROR is surfaced as a generic INTERNAL_ERROR — never leak cause.
      const errorCode = result.error.code === 'DB_ERROR' ? 'INTERNAL_ERROR' : result.error.code;
      return c.json({ error: errorCode }, status);
    }

    return c.json({ wamid: result.value.wamid, sentAt: result.value.sentAt.toISOString() }, 200);
  });

  return router;
};
