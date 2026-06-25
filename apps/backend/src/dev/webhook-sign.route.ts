/**
 * webhook-sign.route.ts — Dev-only signing proxy route.
 *
 * Mounted at /dev/webhook-sign ONLY when ENABLE_DEV_ENDPOINTS=true.
 * Accepts a JSON body with phone, profileName (optional), and text.
 * Builds a Meta-shaped payload, computes its HMAC-SHA256 signature, and
 * returns { payload, signatureHeader, wamid } so the browser can POST the
 * byte-identical payload to the real webhook endpoint.
 *
 * SECURITY:
 * - WHATSAPP_APP_SECRET MUST NOT appear in the response body.
 * - WHATSAPP_APP_SECRET MUST NOT be logged at any level.
 * - This route MUST NOT be mounted in production (ENABLE_DEV_ENDPOINTS=false by default).
 *
 * Functional composition — no DI container, no classes, no decorators.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { DEV_PHONE_NUMBER_ID } from '../db/seed-dev.js';
import { buildSignedMetaPayload } from '../webhooks/sign-payload.js';

// ---------------------------------------------------------------------------
// Zod input schema
// ---------------------------------------------------------------------------

const signBodySchema = z.object({
  phone: z.string().min(1),
  profileName: z.string().optional(),
  text: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the dev signing proxy sub-router.
 * Must be mounted under /dev by buildApp when ENABLE_DEV_ENDPOINTS=true.
 *
 * @param deps - Application dependencies (db + env).
 * @returns A Hono sub-router with POST /webhook-sign.
 */
export function createDevRoute(deps: AppDeps): Hono {
  const router = new Hono();

  router.post('/webhook-sign', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const parsed = signBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.issues }, 400);
    }

    const { phone, profileName, text } = parsed.data;

    // phoneNumberId comes from the seeded dev value (seed-dev.ts).
    // WHATSAPP_APP_SECRET is used server-side only and must not appear in the response.
    const phoneNumberId = DEV_PHONE_NUMBER_ID;

    const result = buildSignedMetaPayload({
      phone,
      ...(profileName !== undefined ? { profileName } : {}),
      text,
      phoneNumberId,
      // appSecret is consumed here and MUST NOT appear in the response.
      appSecret: deps.env.WHATSAPP_APP_SECRET,
    });

    // Return payload string and signatureHeader. wamid is included for UI reference.
    // WHATSAPP_APP_SECRET does not appear here.
    return c.json(
      {
        payload: result.payload,
        signatureHeader: result.signatureHeader,
        wamid: result.wamid,
      },
      200,
    );
  });

  return router;
}
