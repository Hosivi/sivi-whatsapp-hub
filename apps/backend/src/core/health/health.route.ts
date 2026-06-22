/**
 * Health route — public liveness endpoint.
 *
 * GET /health → 200 { status: 'ok', service: 'sivi-whatsapp-hub', ts: <ISO> }
 *
 * Intentionally PUBLIC — no auth, no tenant context.
 * Used by Docker/load-balancer health checks and local dev verification.
 */

import { Hono } from 'hono';

/**
 * Creates the health check sub-router.
 * Mount at root: `app.route('/', createHealthRoute())`.
 */
export function createHealthRoute(): Hono {
  const router = new Hono();

  router.get('/health', (c) => {
    return c.json(
      {
        status: 'ok',
        service: 'sivi-whatsapp-hub',
        ts: new Date().toISOString(),
      },
      200,
    );
  });

  return router;
}
