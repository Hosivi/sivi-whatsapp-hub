/**
 * contacts.tags.int.test.ts — Integration tests for PUT /contacts/:id/tags
 * and DELETE /contacts/:id/tags/:tag.
 *
 * Tests run against a real Postgres 16 container (Testcontainers) with RLS
 * enforced via app_rls. buildApp() wires the full Hono stack.
 *
 * Spec reference: openspec/changes/contacts-tags-intent/specs/contact-tags/spec.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = '44444444-4444-4444-4444-444444444444';
const TENANT_B = '55555555-5555-5555-5555-555555555555';
const PHONE_A = '+51900000001';
const _PHONE_B = '+51900000002';

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
// PUT /contacts/:id/tags
// ---------------------------------------------------------------------------

describe('PUT /contacts/:id/tags', () => {
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

  it('200 — replace happy path: valid tag set replaces existing tags', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, tags: ['old'] });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const res = await app.request(`/contacts/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ tags: ['Sales', 'VIP'] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(['Sales', 'VIP']);
  });

  it('200 — deduplicate: duplicates are removed (first-occurrence wins)', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const res = await app.request(`/contacts/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ tags: ['Lead', 'Lead', 'VIP'] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(['Lead', 'VIP']);
  });

  it('200 — trim: tags are trimmed before validation and persistence', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const res = await app.request(`/contacts/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ tags: ['  Sales  '] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(['Sales']);
  });

  it('422 — empty or whitespace-only tag is rejected', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const res = await app.request(`/contacts/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ tags: ['  '] }),
    });

    expect(res.status).toBe(422);
  });

  it('422 — tag exceeding 60 characters is rejected', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const longTag = 'a'.repeat(61);
    const res = await app.request(`/contacts/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ tags: [longTag] }),
    });

    expect(res.status).toBe(422);
  });

  it('422 — tag count exceeding 50 is rejected', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const tooManyTags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
    const res = await app.request(`/contacts/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ tags: tooManyTags }),
    });

    expect(res.status).toBe(422);
  });

  it('404 — unknown contact returns 404', async () => {
    const res = await app.request('/contacts/00000000-0000-0000-0000-000000000000/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ tags: ['Sales'] }),
    });

    expect(res.status).toBe(404);
  });

  it('404 — cross-tenant write is blocked by RLS', async () => {
    // Seed contact under tenant A, but request as tenant B → 404 (RLS isolation)
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const res = await app.request(`/contacts/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_B },
      body: JSON.stringify({ tags: ['Malicious'] }),
    });

    expect(res.status).toBe(404);
  });

  it('400 — Zod validation: body with wrong type is rejected', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    // tags must be an array — sending a string is a Zod structure error → 400
    const res = await app.request(`/contacts/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ tags: 'not-an-array' }),
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /contacts/:id/tags/:tag
// ---------------------------------------------------------------------------

describe('DELETE /contacts/:id/tags/:tag', () => {
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

  it('200 — removes an existing tag', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, tags: ['Lead', 'VIP'] });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const res = await app.request(`/contacts/${id}/tags/Lead`, {
      method: 'DELETE',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(['VIP']);
  });

  it('200 — idempotent no-op when tag is absent', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, tags: ['VIP'] });
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const id = list.data[0]?.id;

    const res = await app.request(`/contacts/${id}/tags/Lead`, {
      method: 'DELETE',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(['VIP']);
  });

  it('404 — unknown contact returns 404', async () => {
    const res = await app.request('/contacts/00000000-0000-0000-0000-000000000000/tags/Lead', {
      method: 'DELETE',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res.status).toBe(404);
  });
});
