/**
 * whatsapp-send.route.ts — POST /whatsapp-send route.
 *
 * Tenant middleware runs on all routes (X-Tenant-Id → tenantId, else 401/400).
 * Zod validates { to: E.164, text: non-empty } → 422 VALIDATION_ERROR on failure.
 * Delegates to sendWhatsappText service; maps WhatsappSendError to HTTP via sendErrorToHttpStatus.
 * DB_ERROR is surfaced as INTERNAL_ERROR (never leak cause).
 *
 * Mirrors contacts.route.ts: tenant middleware on *, JSON-parse guard,
 * Zod safeParse, exported error mapper, generic INTERNAL_ERROR for DB_ERROR.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { createTenantMiddleware } from '../http/tenant.middleware.js';
import { sendErrorToHttpStatus } from './whatsapp-send.errors.js';
import { sendWhatsappText } from './whatsapp-send.service.js';

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  // E.164 pattern: + followed by country code and subscriber number (7-15 digits total).
  to: z.string().regex(/^\+[1-9]\d{1,14}$/, 'must be a valid E.164 phone number (+XXXXXXXXXXX)'),
  text: z.string().min(1, 'text must not be empty'),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export const createWhatsappSendRoute = (deps: AppDeps): Hono => {
  const router = new Hono<{ Variables: { tenantId: string } }>();

  // Tenant middleware on all routes (X-Tenant-Id header required).
  router.use('*', createTenantMiddleware(deps.env));

  router.post('/', async (c) => {
    // JSON-parse guard
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    // Zod validation
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.issues }, 422);
    }

    const tenantId = c.get('tenantId');
    const result = await sendWhatsappText(deps, tenantId, parsed.data);

    if (!result.ok) {
      const status = sendErrorToHttpStatus(result.error);
      // DB_ERROR is surfaced as a generic INTERNAL_ERROR — never leak cause.
      const errorCode = result.error.code === 'DB_ERROR' ? 'INTERNAL_ERROR' : result.error.code;
      return c.json({ error: errorCode }, status);
    }

    return c.json(result.value, 200);
  });

  return router;
};
