/**
 * app.ts — Hono application factory.
 *
 * buildApp() wires all routes and returns a configured Hono app instance.
 * Kept separate from main.ts so tests can import it without starting an HTTP server.
 *
 * ROUTE LAYOUT
 * ────────────
 * PUBLIC:
 *   GET /health → 200 { status: 'ok', service: 'sivi-whatsapp-hub', ts: <ISO> }
 *
 * Functional composition — no DI container, no classes, no decorators.
 */

import { Hono } from 'hono';
import { createHealthRoute } from './core/health/health.route.js';

/**
 * Builds and returns the configured Hono application.
 *
 * @returns A Hono app instance ready for `serve()` or direct `.fetch()` in tests.
 *
 * @example
 * ```ts
 * // main.ts
 * const app = buildApp();
 * serve({ fetch: app.fetch, port: 3001 });
 *
 * // test
 * const app = buildApp();
 * const res = await app.request('/health');
 * ```
 */
export function buildApp(): Hono {
  const app = new Hono();

  app.route('/', createHealthRoute());

  return app;
}
