/**
 * contacts.intent.int.test.ts — Integration tests for PUT /contacts/:id/intent.
 *
 * Tests run against a real Postgres 16 container (Testcontainers) with RLS
 * enforced via app_rls. buildApp() wires the full Hono stack.
 *
 * Spec reference: openspec/changes/contacts-tags-intent/specs/contact-intent/spec.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = '66666666-6666-6666-6666-666666666666';
const TENANT_B = '77777777-7777-7777-7777-777777777777';
const PHONE_A = '+51900000003';

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

// ---------------------------------------------------------------------------
// Helper: get the first contact id for a tenant
// ---------------------------------------------------------------------------

async function getFirstContactId(
  app: ReturnType<typeof buildApp>,
  tenantId: string,
): Promise<string> {
  const res = await app.request('/contacts', {
    headers: { 'X-Tenant-Id': tenantId },
  });
  const body = (await res.json()) as { data: Array<{ id: string }> };
  const id = body.data[0]?.id;
  if (!id) throw new Error('No contact found in test setup');
  return id;
}

// ---------------------------------------------------------------------------
// PUT /contacts/:id/intent
// ---------------------------------------------------------------------------

describe('PUT /contacts/:id/intent', () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({ db, env: makeEnv(), meta: createFakeMetaClient() });
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('200 — set intent without confidence', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const id = await getFirstContactId(app, TENANT_A);

    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: 'interested-in-service' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { intent: string | null; intentConfidence: string | null };
    expect(body.intent).toBe('interested-in-service');
  });

  it('200 — set intent with confidence 0.9', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const id = await getFirstContactId(app, TENANT_A);

    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: 'interested-in-service', intentConfidence: 0.9 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { intent: string | null; intentConfidence: string | null };
    expect(body.intent).toBe('interested-in-service');
    // intentConfidence is stored as numeric/string in Postgres; accept both
    expect(Number(body.intentConfidence)).toBeCloseTo(0.9, 5);
  });

  it('200 — intent:null clears both intent and intentConfidence', async () => {
    await db.seedTenant(TENANT_A, {
      phoneE164: PHONE_A,
      intent: 'interested-in-service',
      intentConfidence: 0.9,
    });
    const id = await getFirstContactId(app, TENANT_A);

    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: null }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { intent: string | null; intentConfidence: string | null };
    expect(body.intent).toBeNull();
    expect(body.intentConfidence).toBeNull();
  });

  it('200 — idempotent clear when intent is already null', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, intent: null, intentConfidence: null });
    const id = await getFirstContactId(app, TENANT_A);

    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: null }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { intent: string | null; intentConfidence: string | null };
    expect(body.intent).toBeNull();
    expect(body.intentConfidence).toBeNull();
  });

  it('422 — empty string intent is rejected', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const id = await getFirstContactId(app, TENANT_A);

    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: '' }),
    });

    expect(res.status).toBe(422);
  });

  it('422 — whitespace-only intent is rejected', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const id = await getFirstContactId(app, TENANT_A);

    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: '   ' }),
    });

    expect(res.status).toBe(422);
  });

  it('422 — intent exceeding 120 characters is rejected', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const id = await getFirstContactId(app, TENANT_A);

    const longIntent = 'a'.repeat(121);
    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: longIntent }),
    });

    expect(res.status).toBe(422);
  });

  it('422 — confidence without intent (intent:null + confidence:0.8) is rejected with INVALID_INTENT', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const id = await getFirstContactId(app, TENANT_A);

    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: null, intentConfidence: 0.8 }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('INVALID_INTENT');
  });

  it('400 — out-of-range intentConfidence (1.5) is rejected by Zod', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const id = await getFirstContactId(app, TENANT_A);

    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: 'follow-up', intentConfidence: 1.5 }),
    });

    expect(res.status).toBe(400);
  });

  it('404 — unknown contact returns 404', async () => {
    const res = await app.request('/contacts/00000000-0000-0000-0000-000000000000/intent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ intent: 'follow-up' }),
    });

    expect(res.status).toBe(404);
  });

  it('404 — cross-tenant write is blocked by RLS', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const id = await getFirstContactId(app, TENANT_A);

    // Request as tenant B — RLS will scope out tenant A's contact → 404
    const res = await app.request(`/contacts/${id}/intent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_B },
      body: JSON.stringify({ intent: 'malicious-intent' }),
    });

    expect(res.status).toBe(404);
  });
});
