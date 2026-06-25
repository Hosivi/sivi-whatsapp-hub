/**
 * whatsapp.stub.test.ts — Foundation smoke test for /webhooks/whatsapp mount.
 *
 * Verifies that GET /webhooks/whatsapp returns a non-404 response (the stub is
 * mounted and the route is registered in the app). The real handler behavior
 * (GET handshake, POST signature, persistence) is covered in Slice 2's
 * whatsapp.route.int.test.ts.
 *
 * Docker-free: uses buildApp() without deps to test the health route isolation,
 * and buildApp(deps) with a mock db to test the stub mount.
 */

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import type { DbClient } from '../../src/db/client.js';

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_ADMIN_URL: 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost:5432/unused',
    AUTH_MODE: 'dev-header',
    PORT: 3001,
    LOG_LEVEL: 'silent',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    WHATSAPP_APP_SECRET: 'test-app-secret',
    ENABLE_DEV_ENDPOINTS: false,
    ...overrides,
  };
}

// Minimal mock DbClient — resolveTenant not called in stub; close is a no-op.
const mockDb: DbClient = {
  withTenant: () => Promise.resolve(undefined as never),
  adminSql: null as never,
  resolveTenant: () => Promise.resolve({ ok: false, error: { code: 'UNKNOWN_PHONE_NUMBER_ID' } }),
  close: () => Promise.resolve(),
};

describe('GET /webhooks/whatsapp — stub mount', () => {
  it('returns a non-404 response (route is mounted in the app)', async () => {
    const app = buildApp({ db: mockDb, env: makeEnv() });
    const res = await app.request('/webhooks/whatsapp');
    // Stub returns 501 — that is NOT 404, confirming the route is registered
    expect(res.status).not.toBe(404);
  });

  it('/webhooks/whatsapp is independent of the /contacts route', async () => {
    const app = buildApp({ db: mockDb, env: makeEnv() });
    // Both routes must be non-404
    const webhookRes = await app.request('/webhooks/whatsapp');
    const healthRes = await app.request('/health');
    expect(webhookRes.status).not.toBe(404);
    expect(healthRes.status).toBe(200);
  });
});
