/**
 * whatsapp-messages.route.ts — Read-back route for /whatsapp-messages.
 *
 * Always mounted (not dev-gated) — it is a normal tenant-scoped domain read
 * and is harmless without dev endpoints enabled.
 *
 * Mirrors the contacts route pattern:
 * - tenant middleware applied via createTenantMiddleware
 * - tenantId extracted from context (set by middleware)
 * - repository receives withTenant + tenantId; never the raw db handle
 *
 * GET / → 200 { data: MessageDTO[] } (received_at DESC, limit 50)
 * No tenant header → 401 (from tenant middleware)
 *
 * Functional composition — no DI container, no classes, no decorators.
 */

import { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { createTenantMiddleware } from '../http/tenant.middleware.js';
import { listMessages } from './whatsapp-messages.repository.js';

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the whatsapp-messages sub-router.
 * Must be always mounted in buildApp (not dev-gated).
 *
 * @param deps - Application dependencies (db + env).
 * @returns A Hono sub-router mountable at /whatsapp-messages.
 */
export function createWhatsappMessagesRoute(deps: AppDeps) {
  const router = new Hono<{ Variables: { tenantId: string } }>();
  const tenantMiddleware = createTenantMiddleware(deps.env);

  // Apply tenant middleware to all routes in this router
  router.use('*', tenantMiddleware);

  // GET / — list messages for the current tenant (received_at DESC, limit 50)
  router.get('/', async (c) => {
    const tenantId = c.get('tenantId');
    const messages = await listMessages(deps.db.withTenant, tenantId);
    return c.json({ data: messages }, 200);
  });

  return router;
}
