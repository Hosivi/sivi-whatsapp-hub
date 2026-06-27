/**
 * whatsapp.route.ts — WhatsApp webhook sub-router.
 *
 * Mounted at /webhooks/whatsapp WITHOUT tenant middleware (tenant is unknown
 * until resolved from phone_number_id by resolveTenant).
 *
 * GET  /webhooks/whatsapp — Meta hub.challenge verification handshake.
 *   Returns 200 + plain-text hub.challenge when hub.mode=subscribe and
 *   hub.verify_token matches WHATSAPP_VERIFY_TOKEN. Returns 403 otherwise.
 *
 * POST /webhooks/whatsapp — Inbound message ingestion (ack-fast contract).
 *   Reads RAW body FIRST (c.req.arrayBuffer() before any JSON parse — Hono
 *   consumes the stream once). Verifies HMAC-SHA256 signature. Zod-parses.
 *   Resolves tenant. Upserts contact. Inserts message (ON CONFLICT DO NOTHING).
 *   Returns 200 in ALL cases to prevent Meta retry storms.
 *   The only non-200 response in this module is the GET 403 on token mismatch.
 */

import { Hono } from 'hono';
import { runAiReply } from '../ai/ai-reply.service.js';
import type { AppDeps } from '../app.js';
import { handleInboundMessage } from './whatsapp.service.js';

/**
 * Creates the WhatsApp webhook sub-router.
 * @param deps - Application dependencies (db + env).
 * @returns A Hono sub-router mountable at /webhooks/whatsapp.
 */
export function createWhatsappWebhookRoute(deps?: AppDeps): Hono {
  const router = new Hono();

  // ---------------------------------------------------------------------------
  // GET / — Meta hub.challenge verification handshake
  // ---------------------------------------------------------------------------

  router.get('/', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');

    if (deps && mode === 'subscribe' && token === deps.env.WHATSAPP_VERIFY_TOKEN) {
      return c.text(challenge ?? '', 200);
    }

    return c.text('Forbidden', 403);
  });

  // ---------------------------------------------------------------------------
  // POST / — Inbound message ingestion (ack-fast: always 200)
  // ---------------------------------------------------------------------------

  router.post('/', async (c) => {
    if (!deps) {
      // deps absent → ack-fast 200 (route is a no-op without real dependencies)
      return c.text('ok', 200);
    }

    // MUST read raw body BEFORE any c.req.json() — Hono consumes the stream once.
    const rawBody = await c.req.arrayBuffer();
    const signatureHeader = c.req.header('X-Hub-Signature-256');

    const result = await handleInboundMessage(deps, rawBody, signatureHeader);

    if (!result.ok) {
      // ALL errors → log + 200 (ack-fast contract: never let Meta retry)
      const { error } = result;
      if (error.code !== 'NO_MESSAGES') {
        // NO_MESSAGES is expected (status-only events); others warrant a warning
        deps.logger.warn(
          { code: error.code, cause: 'cause' in error ? error.cause : undefined },
          '[whatsapp-webhook] POST error',
        );
      }
      return c.text('ok', 200);
    }

    // Ack-fast: fire AI reply in the background — NEVER await before returning 200.
    // runAiReply returns Result (never throws); .catch logs any unexpected infrastructure failure.
    const { tenantId, contactId, fromPhoneE164, text } = result.value;
    if (text !== null) {
      void runAiReply(deps, { tenantId, contactId, fromPhoneE164, text }).catch((cause) =>
        deps.logger.error({ cause }, '[ai-reply] unhandled rejection'),
      );
    }

    return c.text('ok', 200);
  });

  return router;
}
