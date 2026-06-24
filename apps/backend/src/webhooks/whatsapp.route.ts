/**
 * whatsapp.route.ts — WhatsApp webhook sub-router stub.
 *
 * Slice 1 (Foundation): stub only — returns 501 Not Implemented.
 * Slice 2 (Ingestion Logic): GET handshake + POST signature verify + full ingestion.
 *
 * Mounted at /webhooks/whatsapp WITHOUT tenant middleware (tenant is unknown
 * until resolved from phone_number_id by resolveTenant).
 *
 * createWhatsappWebhookRoute MUST compile cleanly under tsc --noEmit in Slice 1
 * so that app.ts mounts it without type errors.
 */

import { Hono } from 'hono';
import type { AppDeps } from '../app.js';

/**
 * Creates the WhatsApp webhook sub-router.
 * Stub implementation for Slice 1 — responds 501 on all methods until Slice 2 ships.
 *
 * @param _deps - Application dependencies (reserved for Slice 2 use).
 * @returns A Hono sub-router mountable at /webhooks/whatsapp.
 */
export function createWhatsappWebhookRoute(_deps?: AppDeps): Hono {
  const router = new Hono();

  // Stub: GET and POST return 501 until Slice 2 implements the real handlers.
  // Mounted as a catch-all so that the route is non-404 (satisfies 1.14 RED test).
  router.all('/', (c) => c.text('Not Implemented', 501));
  router.all('/*', (c) => c.text('Not Implemented', 501));

  return router;
}
