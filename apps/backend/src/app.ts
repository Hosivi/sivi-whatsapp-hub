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
 * Functional composition — no DI container, no classes, no decorators.
 */

import { Hono } from 'hono';
import type { Env } from './config/env.js';
import { createContactsRoute } from './contacts/contacts.route.js';
import { createHealthRoute } from './core/health/health.route.js';
import type { DbClient } from './db/client.js';

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
    app.route('/contacts', createContactsRoute(deps));
  }

  return app;
}
