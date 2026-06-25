/**
 * whatsapp-send.route.unit.test.ts — Pure route unit tests for POST /whatsapp-send.
 *
 * Uses buildApp with createFakeMetaClient and a stub db — no Testcontainers.
 * Tests the tenant middleware enforcement and Zod validation layer only.
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { ok } from '../../src/shared/result.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_ADMIN_URL: 'postgresql://unused:unused@localhost:5432/unused',
    AUTH_MODE: 'dev-header',
    PORT: 3001,
    LOG_LEVEL: 'silent',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    WHATSAPP_APP_SECRET: 'test-app-secret',
    DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost:5432/unused',
    ENABLE_DEV_ENDPOINTS: false,
    WHATSAPP_META_API_VERSION: 'v21.0',
    ...overrides,
  };
}

/**
 * Stub db that returns 0 active accounts (enough to hit tenant middleware checks).
 * The TenantRunner returns an empty array for any execute call.
 */
function makeStubDb() {
  return {
    withTenant: async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        execute: async () => [],
      };
      return run(fakeTx);
    },
    adminSql: {} as never,
    resolveTenant: async () => ok(''),
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /whatsapp-send — route unit tests', () => {
  const db = makeStubDb();
  const meta = createFakeMetaClient();
  const app = buildApp({ db, env: makeEnv(), meta });

  it('(a) missing X-Tenant-Id → 401 before body is read', async () => {
    const res = await app.request('/whatsapp-send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: '+51987654321', text: 'Hola' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('MISSING_TENANT');
    // Meta not called (tenant check fires before body parsing)
    expect(meta.calls).toHaveLength(0);
  });

  it('(b) missing "to" field → 422 VALIDATION_ERROR', async () => {
    const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const res = await app.request('/whatsapp-send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({ text: 'Hola' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('(c) empty text → 422 VALIDATION_ERROR', async () => {
    const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const res = await app.request('/whatsapp-send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({ to: '+51987654321', text: '' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('(d) "to" without leading + (non-E.164) → 422 VALIDATION_ERROR', async () => {
    const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const res = await app.request('/whatsapp-send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({ to: '987654321', text: 'Hola' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });
});
