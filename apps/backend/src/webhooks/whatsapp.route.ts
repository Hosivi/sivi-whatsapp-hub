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
 *   A NEW inbound text (never a re-delivered wamid) is handed to dispatchAutoReply,
 *   which runs in the background after the 200.
 */

import { Hono } from 'hono';
import { type AiReplyInput, runAiReply } from '../ai/ai-reply.service.js';
import type { AppDeps } from '../app.js';
import { handleInboundMessage } from './whatsapp.service.js';

/**
 * The single place that decides how the Hub answers a NEW inbound text.
 * Fire-and-forget: it starts background work and returns at once — never awaited.
 *
 * - AI_REPLY_ENABLED on  → governed AI reply (runAiReply), still gated per tenant by
 *   tenant_ai_config.enabled.
 * - AI_REPLY_ENABLED off → no AI-generated reply, whatever the tenant config says. This is
 *   the default until SiviHub's agent takes over (stage E4); the fixed replies hook in here.
 */
function dispatchAutoReply(deps: AppDeps, input: AiReplyInput): void {
  if (deps.env.AI_REPLY_ENABLED) {
    // runAiReply returns Result (never throws); .catch logs any unexpected infrastructure failure.
    void runAiReply(deps, input).catch((cause) =>
      deps.logger.error({ cause }, '[ai-reply] unhandled rejection'),
    );
    return;
  }

  deps.logger.info({ tenantId: input.tenantId }, 'ai_reply_skipped reason=AI_REPLY_DISABLED');
}

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

    // Ack-fast: the auto-reply runs in the background — NEVER awaited before returning 200.
    // A re-delivered wamid (isNew = false) never triggers a second reply.
    const { tenantId, contactId, fromPhoneE164, text, isNew } = result.value;
    if (isNew && text !== null) {
      dispatchAutoReply(deps, { tenantId, contactId, fromPhoneE164, text });
    }

    return c.text('ok', 200);
  });

  return router;
}
