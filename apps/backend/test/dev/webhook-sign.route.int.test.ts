/**
 * webhook-sign.route.int.test.ts — Integration tests for POST /dev/webhook-sign.
 *
 * Uses Testcontainers (PG16) + buildApp({ db, env }) to test the full stack.
 *
 * Tests:
 * (a) flag off → 404
 * (b) flag on → 200 with { payload, signatureHeader, wamid }
 * (c) flag on + missing text → 400
 * (d) flag on + wamid differs on two identical calls
 * (e) flag on + OPTIONS with Origin: http://localhost:3000 → Access-Control-Allow-Origin present
 * (f) flag off → no Access-Control-Allow-Origin on any request
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('/dev/webhook-sign', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.teardown();
  });

  // -------------------------------------------------------------------------
  // (a) flag off → 404
  // -------------------------------------------------------------------------

  it('(a) ENABLE_DEV_ENDPOINTS=false → POST /dev/webhook-sign returns 404', async () => {
    const app = buildApp({ db, env: makeEnv({ ENABLE_DEV_ENDPOINTS: false }) });
    const res = await app.request('/dev/webhook-sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+51987654321', text: 'Hola' }),
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // (b) flag on → 200 with correct shape
  // -------------------------------------------------------------------------

  it('(b) ENABLE_DEV_ENDPOINTS=true → POST /dev/webhook-sign returns 200 with { payload, signatureHeader, wamid }', async () => {
    const app = buildApp({ db, env: makeEnv({ ENABLE_DEV_ENDPOINTS: true }) });
    const res = await app.request('/dev/webhook-sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+51987654321', profileName: 'Test User', text: 'Hola' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.payload).toBe('string');
    expect(typeof body.signatureHeader).toBe('string');
    expect((body.signatureHeader as string).startsWith('sha256=')).toBe(true);
    expect(typeof body.wamid).toBe('string');
    expect((body.wamid as string).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // (c) flag on + missing text → 400
  // -------------------------------------------------------------------------

  it('(c) flag on + missing text field → 400', async () => {
    const app = buildApp({ db, env: makeEnv({ ENABLE_DEV_ENDPOINTS: true }) });
    const res = await app.request('/dev/webhook-sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+51987654321' }), // no text
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // (d) wamid differs on two identical calls
  // -------------------------------------------------------------------------

  it('(d) wamid differs on two consecutive identical calls', async () => {
    const app = buildApp({ db, env: makeEnv({ ENABLE_DEV_ENDPOINTS: true }) });
    const body = JSON.stringify({ phone: '+51987654321', text: 'Same text' });
    const headers = { 'Content-Type': 'application/json' };

    const res1 = await app.request('/dev/webhook-sign', { method: 'POST', headers, body });
    const res2 = await app.request('/dev/webhook-sign', { method: 'POST', headers, body });

    const b1 = (await res1.json()) as Record<string, unknown>;
    const b2 = (await res2.json()) as Record<string, unknown>;

    expect(b1.wamid).not.toBe(b2.wamid);
  });

  // -------------------------------------------------------------------------
  // (e) CORS present when flag on
  // -------------------------------------------------------------------------

  it('(e) flag on → OPTIONS /dev/webhook-sign with Origin: http://localhost:3000 includes Access-Control-Allow-Origin', async () => {
    const app = buildApp({ db, env: makeEnv({ ENABLE_DEV_ENDPOINTS: true }) });
    const res = await app.request('/dev/webhook-sign', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const acao = res.headers.get('Access-Control-Allow-Origin');
    expect(acao).toBe('http://localhost:3000');
  });

  // -------------------------------------------------------------------------
  // (e2) non-localhost origin → CORS header absent (origin fn returns null)
  // -------------------------------------------------------------------------

  it('(e2) flag on + non-localhost Origin → Access-Control-Allow-Origin is absent', async () => {
    const app = buildApp({ db, env: makeEnv({ ENABLE_DEV_ENDPOINTS: true }) });
    const res = await app.request('/dev/webhook-sign', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const acao = res.headers.get('Access-Control-Allow-Origin');
    expect(acao).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (e3) any localhost port → CORS header echoes that port
  // -------------------------------------------------------------------------

  it('(e3) flag on + Origin: http://localhost:3003 → Access-Control-Allow-Origin: http://localhost:3003', async () => {
    const app = buildApp({ db, env: makeEnv({ ENABLE_DEV_ENDPOINTS: true }) });
    const res = await app.request('/dev/webhook-sign', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3003',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const acao = res.headers.get('Access-Control-Allow-Origin');
    expect(acao).toBe('http://localhost:3003');
  });

  // -------------------------------------------------------------------------
  // (f) CORS absent when flag off
  // -------------------------------------------------------------------------

  it('(f) flag off → no Access-Control-Allow-Origin on any request', async () => {
    const app = buildApp({ db, env: makeEnv({ ENABLE_DEV_ENDPOINTS: false }) });
    const res = await app.request('/dev/webhook-sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ phone: '+51987654321', text: 'Hola' }),
    });
    const acao = res.headers.get('Access-Control-Allow-Origin');
    expect(acao).toBeNull();
  });
});
