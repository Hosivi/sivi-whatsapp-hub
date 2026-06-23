/**
 * contacts.import.int.test.ts — Integration tests for POST /contacts/import.
 *
 * Uses Testcontainers (PG16) + buildApp({ db, env }) through the real HTTP stack.
 * ONE shared container across all describe blocks (starts once, truncated between tests).
 *
 * Covers: happy-path import, batch duplicate, invalid phone, already-exists,
 *         resurrect (NON-OPTIONAL regression guard for ADR-001 timestamp signal),
 *         batch-level 400 validation, and tenant isolation via RLS.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { contactsTable } from '../../src/db/schema/contacts.schema.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const PHONE_1 = '987654321'; // normalizes to +51987654321
const PHONE_2 = '912345678'; // normalizes to +51912345678
const PHONE_3 = '955555555'; // normalizes to +51955555555

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_ADMIN_URL: 'postgresql://unused:unused@localhost:5432/unused',
    AUTH_MODE: 'dev-header',
    PORT: 3001,
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared container (created once, torn down after all tests in this file)
// ---------------------------------------------------------------------------

let db: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({ db, env: makeEnv() });
}, 120_000);

afterAll(async () => {
  await db.teardown();
});

beforeEach(async () => {
  await db.truncate();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeImportBody(phones: string[]): string {
  return JSON.stringify({
    contacts: phones.map((phone) => ({ phone })),
  });
}

async function importContacts(
  tenantId: string,
  phones: string[],
): Promise<{ status: number; body: unknown }> {
  const res = await app.request('/contacts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
    body: makeImportBody(phones),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// 1. Happy path — 3 valid new rows
// ---------------------------------------------------------------------------

describe('POST /contacts/import — happy path', () => {
  it('200 — 3 valid new rows, summary.imported === 3, each row has index + input + contactId', async () => {
    const res = await app.request('/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({
        contacts: [
          { phone: PHONE_1, fullName: 'Alice' },
          { phone: PHONE_2, fullName: 'Bob' },
          { phone: PHONE_3 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const summary = body.summary as Record<string, unknown>;
    expect(summary.total).toBe(3);
    expect(summary.imported).toBe(3);
    expect(summary.resurrected).toBe(0);
    expect(summary.errors).toBe(0);

    const rows = body.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);

    for (let i = 0; i < 3; i++) {
      const r = rows[i];
      expect(r).toBeDefined();
      if (!r) continue;
      expect(r.index).toBe(i);
      expect(typeof r.contactId).toBe('string');
      expect(r.outcome ?? r.status).toBe('imported');
      expect(r.input).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Within-batch duplicate
// ---------------------------------------------------------------------------

describe('POST /contacts/import — within-batch duplicate', () => {
  it('200 — same phone twice → first imported, second skipped-duplicate-in-batch', async () => {
    const { status, body } = await importContacts(TENANT_A, [PHONE_1, PHONE_1]);
    const b = body as Record<string, unknown>;
    const summary = b.summary as Record<string, unknown>;

    expect(status).toBe(200);
    expect(summary.imported).toBe(1);
    expect(summary.skippedDuplicateInBatch).toBe(1);

    const rows = b.rows as Array<Record<string, unknown>>;
    const r0 = rows[0];
    expect(r0?.status ?? r0?.outcome).toBe('imported');
    const r1 = rows[1];
    expect(r1?.status ?? r1?.outcome).toBe('skipped-duplicate-in-batch');
    expect(r1?.canonicalRowIndex).toBe(0);

    // DB must have exactly ONE contact row for this phone
    const getRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const listBody = (await getRes.json()) as { data: unknown[] };
    expect(listBody.data.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid phone in batch
// ---------------------------------------------------------------------------

describe('POST /contacts/import — invalid phone', () => {
  it('200 (not 400) — invalid Peru mobile in batch produces skipped-invalid-phone row', async () => {
    const res = await app.request('/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ contacts: [{ phone: 'not-a-number' }, { phone: PHONE_1 }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const rows = body.rows as Array<Record<string, unknown>>;
    const summary = body.summary as Record<string, unknown>;

    expect(rows[0]?.status ?? rows[0]?.outcome).toBe('skipped-invalid-phone');
    expect(summary.skippedInvalidPhone).toBe(1);
    expect(summary.imported).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Already-live phone
// ---------------------------------------------------------------------------

describe('POST /contacts/import — already-exists', () => {
  it('skipped-already-exists for a live phone; existing contact row unchanged', async () => {
    // First create the contact directly
    await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: PHONE_1, fullName: 'Original' }),
    });

    const { status, body } = await importContacts(TENANT_A, [PHONE_1]);
    const b = body as Record<string, unknown>;
    const summary = b.summary as Record<string, unknown>;

    expect(status).toBe(200);
    expect(summary.skippedAlreadyExists).toBe(1);
    expect(summary.imported).toBe(0);

    // Existing contact must still be there
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    const listBody = (await listRes.json()) as { data: Array<Record<string, unknown>> };
    expect(listBody.data.length).toBe(1);
    expect(listBody.data[0]?.fullName).toBe('Original');
  });
});

// ---------------------------------------------------------------------------
// 5. RESURRECT — NON-OPTIONAL regression guard for ADR-001 timestamp signal
// ---------------------------------------------------------------------------

describe('POST /contacts/import — resurrect', () => {
  it('resurrected contact gets same id, deletedAt cleared; createdAt < updatedAt at real DB layer', async () => {
    // Step 1: create the contact
    const createRes = await app.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ phone: PHONE_1, fullName: 'Ana' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    const originalId = created.id as string;
    expect(typeof originalId).toBe('string');

    // Step 2: soft-delete via DELETE route
    const delRes = await app.request(`/contacts/${originalId}`, {
      method: 'DELETE',
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(delRes.status).toBe(204);

    // Step 3: import same phone → must resurrect
    const res = await app.request('/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ contacts: [{ phone: PHONE_1, fullName: 'Ana Reborn' }] }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    const rows = body.rows as Array<Record<string, unknown>>;
    const summary = body.summary as Record<string, unknown>;

    expect(summary.resurrected).toBe(1);
    expect(summary.imported).toBe(0);

    const r0 = rows[0];
    expect(r0).toBeDefined();
    if (!r0) return;

    expect(r0.status ?? r0.outcome).toBe('resurrected');
    // contactId MUST equal the original id (same DB row, not a new one)
    expect(r0.contactId).toBe(originalId);

    // Step 4: assert via adminQuery that deletedAt was cleared
    await db.adminQuery(async (tx) => {
      const dbRows = await tx.select().from(contactsTable).where(eq(contactsTable.id, originalId));

      const row = dbRows[0];
      expect(row).toBeDefined();
      if (!row) return;

      expect(row.deletedAt).toBeNull();
      // ADR-001 regression: createdAt strictly less than updatedAt after resurrect
      expect(row.createdAt.getTime()).toBeLessThan(row.updatedAt.getTime());
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Batch-level 400 validation
// ---------------------------------------------------------------------------

describe('POST /contacts/import — batch validation', () => {
  it('400 — empty contacts array', async () => {
    const res = await app.request('/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ contacts: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('400 — 201-element array exceeds max', async () => {
    const phones = Array.from({ length: 201 }, (_, i) => {
      const n = 900000000 + i;
      return { phone: String(n) };
    });

    const res = await app.request('/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ contacts: phones }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('400 — malformed body (not JSON)', async () => {
    const res = await app.request('/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('400 — missing contacts key', async () => {
    const res = await app.request('/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_A },
      body: JSON.stringify({ data: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// 7. TENANT ISOLATION — RLS scoping through bulk import path
// ---------------------------------------------------------------------------

describe('POST /contacts/import — tenant isolation', () => {
  it('TENANT_A import invisible to TENANT_B; TENANT_B can import same phone fresh', async () => {
    // Import phone under TENANT_A
    const resA = await importContacts(TENANT_A, [PHONE_1]);
    expect((resA.body as Record<string, unknown>).summary).toBeDefined();
    expect(
      ((resA.body as Record<string, unknown>).summary as Record<string, unknown>).imported,
    ).toBe(1);

    // TENANT_B: GET /contacts must not see TENANT_A's phone
    const listRes = await app.request('/contacts', {
      headers: { 'X-Tenant-Id': TENANT_B },
    });
    const listBody = (await listRes.json()) as { data: unknown[] };
    expect(listBody.data.length).toBe(0);

    // TENANT_B: import same phone → must be imported (not skipped-already-exists)
    const resB = await importContacts(TENANT_B, [PHONE_1]);
    const bBody = resB.body as Record<string, unknown>;
    const bSummary = bBody.summary as Record<string, unknown>;
    expect(resB.status).toBe(200);
    expect(bSummary.imported).toBe(1);
    expect(bSummary.skippedAlreadyExists).toBe(0);
  });
});
