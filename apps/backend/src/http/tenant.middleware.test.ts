/**
 * tenant.middleware.test.ts — Unit tests for createTenantMiddleware.
 * Docker-free: pure Vitest, no container needed.
 *
 * Tests verify:
 * - Missing X-Tenant-Id header → 401 { "error": "MISSING_TENANT" }
 * - Non-UUID X-Tenant-Id → 400 { "error": "INVALID_TENANT_ID" }
 * - Valid UUID → c.set('tenantId', uuid) called and next() invoked
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { createTenantMiddleware } from './tenant.middleware.js';

const DEV_HEADER_ENV: Env = {
  DATABASE_URL: 'postgresql://app_rls:pass@localhost/hub',
  DATABASE_ADMIN_URL: 'postgresql://postgres:admin@localhost/hub',
  AUTH_MODE: 'dev-header',
  PORT: 3001,
  LOG_LEVEL: 'info',
  WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost/hub',
  ENABLE_DEV_ENDPOINTS: false,
  WHATSAPP_META_API_VERSION: 'v21.0',
};

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Builds a minimal Hono app with the tenant middleware mounted on GET /test.
 * The route handler returns 200 with the tenantId that was set by the middleware.
 */
function buildTestApp(env: Env): Hono<{ Variables: { tenantId: string } }> {
  const app = new Hono<{ Variables: { tenantId: string } }>();
  app.use('/test', createTenantMiddleware(env));
  app.get('/test', (c) => c.json({ tenantId: c.get('tenantId') }, 200));
  return app;
}

describe('createTenantMiddleware — AUTH_MODE=dev-header', () => {
  it('returns 401 MISSING_TENANT when X-Tenant-Id header is absent', async () => {
    const app = buildTestApp(DEV_HEADER_ENV);
    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('MISSING_TENANT');
  });

  it('returns 401 MISSING_TENANT when X-Tenant-Id header is empty string', async () => {
    const app = buildTestApp(DEV_HEADER_ENV);
    const res = await app.request('/test', {
      headers: { 'X-Tenant-Id': '' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('MISSING_TENANT');
  });

  it('returns 400 INVALID_TENANT_ID when X-Tenant-Id is not a UUID', async () => {
    const app = buildTestApp(DEV_HEADER_ENV);
    const res = await app.request('/test', {
      headers: { 'X-Tenant-Id': 'not-a-uuid' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('INVALID_TENANT_ID');
  });

  it('returns 400 INVALID_TENANT_ID for a partial UUID', async () => {
    const app = buildTestApp(DEV_HEADER_ENV);
    const res = await app.request('/test', {
      headers: { 'X-Tenant-Id': '550e8400-e29b-41d4' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('INVALID_TENANT_ID');
  });

  it('sets tenantId and calls next() when X-Tenant-Id is a valid UUID', async () => {
    const app = buildTestApp(DEV_HEADER_ENV);
    const res = await app.request('/test', {
      headers: { 'X-Tenant-Id': VALID_UUID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string };
    expect(body.tenantId).toBe(VALID_UUID);
  });
});
