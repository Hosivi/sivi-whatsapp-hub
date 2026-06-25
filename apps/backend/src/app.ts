/**
 * app.ts — Hono application factory.
 *
 * buildApp(deps?) wires all routes and returns a configured Hono app instance.
 * Kept separate from main.ts so tests can import it without starting an HTTP server.
 *
 * Calling buildApp() with no arguments mounts ONLY the health route — this is
 * required for health.test.ts to pass without a DB connection.
 *
 * Calling buildApp({ db, env }) additionally mounts the contacts CRUD routes
 * behind the tenant middleware.
 *
 * ROUTE LAYOUT
 * ────────────
 * Always:
 *   GET /health → 200 { status: 'ok', service: 'sivi-whatsapp-hub', ts: <ISO> }
 *
 * When deps present:
 *   POST   /contacts         → 201 Contact
 *   GET    /contacts         → 200 { data: Contact[] }
 *   GET    /contacts/:id     → 200 Contact
 *   PATCH  /contacts/:id     → 200 Contact
 *   DELETE /contacts/:id     → 204
 *
 * When deps present AND ENABLE_DEV_ENDPOINTS=true:
 *   CORS   * (dev-only: any http://localhost:<port> origin allowed, gated by ENABLE_DEV_ENDPOINTS)
 *   POST   /dev/webhook-sign → 200 { payload, signatureHeader, wamid }
 *
 * Always when deps present:
 *   GET    /whatsapp-messages → 200 { data: MessageDTO[] } (tenant middleware)
 *
 * Functional composition — no DI container, no classes, no decorators.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './config/env.js';
import { createContactsRoute } from './contacts/contacts.route.js';
import { createHealthRoute } from './core/health/health.route.js';
import type { DbClient } from './db/client.js';
import { createDevRoute } from './dev/webhook-sign.route.js';
import { createWhatsappWebhookRoute } from './webhooks/whatsapp.route.js';
import { createWhatsappMessagesRoute } from './whatsapp-messages/whatsapp-messages.route.js';

export type AppDeps = {
  readonly db: DbClient;
  readonly env: Env;
};

/**
 * Builds and returns the configured Hono application.
 *
 * @param deps - Optional database client and env config.
 *   When omitted, only the health endpoint is mounted.
 *   When provided, contacts CRUD routes are mounted behind the tenant middleware.
 *
 * @returns A Hono app instance ready for `serve()` or direct `.fetch()` in tests.
 *
 * @example
 * ```ts
 * // health-only (tests, local dev without DB)
 * const app = buildApp();
 *
 * // full app (main.ts)
 * const app = buildApp({ db: client, env });
 * serve({ fetch: app.fetch, port: env.PORT });
 * ```
 */
export function buildApp(deps?: AppDeps): Hono {
  const app = new Hono();

  app.route('/', createHealthRoute());

  if (deps) {
    // Dev-only routes + CORS — gated by ENABLE_DEV_ENDPOINTS (default false = prod-safe).
    // Guard checked at app construction time (not per-request).
    if (deps.env.ENABLE_DEV_ENDPOINTS) {
      // Dev CORS: allow any localhost port so the web app can run on whatever
      // port is free (3000/3003/etc.) without clashing with other local projects.
      // Dev-only — this whole block is gated by ENABLE_DEV_ENDPOINTS (prod-inert).
      app.use(
        '*',
        cors({ origin: (origin) => (/^http:\/\/localhost:\d+$/.test(origin) ? origin : null) }),
      );
      app.route('/dev', createDevRoute(deps));
    }

    app.route('/contacts', createContactsRoute(deps));
    // WhatsApp webhook — NO tenant middleware (tenant resolved from phone_number_id).
    app.route('/webhooks/whatsapp', createWhatsappWebhookRoute(deps));
    // Always mounted (not dev-gated) — tenant-scoped read of persisted messages.
    app.route('/whatsapp-messages', createWhatsappMessagesRoute(deps));
  }

  return app;
}
