/**
 * contacts.route.int.test.ts — Integration tests for the /contacts HTTP routes.
 *
 * Uses Testcontainers (PG16) + buildApp({ db, env }) to exercise the full stack:
 * tenant middleware → route → repository → Postgres (RLS enforced).
 *
 * Response envelope for GET /contacts: { data: [...] }
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = '22222222-2222-2222-2222-222222222222';
const TENANT_B = '33333333-3333-3333-3333-333333333333';
const VALID_PHONE = '987654321';
const _VALID_PHONE_2 = '912345678';

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
    ...overrides,
  };
}

describe('POST /contacts', () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({ db, env: makeEnv() });
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('201 — creates a contact with valid phone and tenant header', async () => {
    const res = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE, fullName: 'Alice' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.phoneE164).toBe('+51987654321');
  });

  it('409 — conflict when phone already exists for tenant', async () => {
    const app2 = buildApp({ db, env: makeEnv() });
    await app2.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });

    const res = await app2.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });
    expect(res.status).toBe(409);
  });

  it('422 — invalid phone string', async () => {
    const res = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: 'not-a-phone' }),
    });
    expect(res.status).toBe(422);
  });

  it('400 — missing phone field (Zod validation)', async () => {
    const res = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ fullName: 'No Phone' }),
    });
    expect(res.status).toBe(400);
  });

  it('401 — missing tenant header', async () => {
    const res = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });
    expect(res.status).toBe(401);
  });

  it('400 — non-UUID tenant header', async () => {
    const res = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'not-a-uuid' },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /contacts', () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({ db, env: makeEnv() });
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('200 — returns { data: [] } when no contacts exist', async () => {
    const res = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.data).toEqual([]);
  });

  it('200 — returns { data: [...] } with contacts', async () => {
    await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE, fullName: 'Bob' }),
    });

    const res = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(1);
  });

  it('200 — tenant isolation: tenant B cannot see tenant A contacts', async () => {
    await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });

    const res = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_B },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.data as unknown[]).length).toBe(0);
  });
});

describe('GET /contacts/:id', () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({ db, env: makeEnv() });
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('200 — returns the contact', async () => {
    const createRes = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await app.request(`/contacts/${created.id}`, {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(200);
  });

  it('404 — soft-deleted contact', async () => {
    const createRes = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    await app.request(`/contacts/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    const res = await app.request(`/contacts/${created.id}`, {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(404);
  });

  it('404 — missing id', async () => {
    const res = await app.request('/contacts/00000000-0000-0000-0000-000000000000', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /contacts/:id', () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({ db, env: makeEnv() });
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('200 — updates contact fields', async () => {
    const createRes = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE, fullName: 'Carol' }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await app.request(`/contacts/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ fullName: 'Carol Updated' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fullName).toBe('Carol Updated');
  });

  it('404 — soft-deleted or missing target', async () => {
    const res = await app.request('/contacts/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ fullName: 'Ghost' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /contacts/:id', () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({ db, env: makeEnv() });
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('204 — soft-deletes a contact', async () => {
    const createRes = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await app.request(`/contacts/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(204);
  });

  it('404 on subsequent GET after delete', async () => {
    const createRes = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: VALID_PHONE }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    await app.request(`/contacts/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    const res = await app.request(`/contacts/${created.id}`, {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(404);
  });

  it('404 — missing id', async () => {
    const res = await app.request('/contacts/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(404);
  });
});
