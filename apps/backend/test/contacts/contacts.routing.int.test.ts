/**
 * contacts.routing.int.test.ts — Integration tests for routeContact + POST /contacts/:id/route.
 *
 * Uses Testcontainers (PG16 as app_rls) + shared container for all scenarios.
 * Both the service-level (routeContact) and HTTP-layer scenarios are exercised.
 *
 * TDD: ALL tests were written first (RED) before the route handler was registered.
 *
 * Test container notes:
 *   - ONE shared container for the entire file (beforeAll/afterAll).
 *   - afterEach truncates both contact_lead_outbox and contacts (clean slate per test).
 *   - adminQuery is used for cross-RLS assertions and the atomicity REVOKE/GRANT test.
 */

import { contactLeadSchema } from '@sivihub/contracts';
import { sql as rawSql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { routeContact } from '../../src/contacts/contacts.routing.js';
import { contactLeadOutboxTable } from '../../src/db/schema/contact-lead-outbox.schema.js';
import { contactsTable } from '../../src/db/schema/contacts.schema.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const PHONE_A = '+51987654321';
const PHONE_B = '+51912345678';
const PHONE_C = '+51911111111';

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
    AI_MODEL: 'claude-haiku-4-5',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared container
// ---------------------------------------------------------------------------

let db: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({
    db,
    env: makeEnv(),
    meta: createFakeMetaClient(),
    llm: createFakeLlmAdapter(),
    logger: pino({ level: 'silent' }),
  });
}, 120_000);

afterAll(async () => {
  await db.teardown();
});

afterEach(async () => {
  await db.truncate();
});

// ---------------------------------------------------------------------------
// Helper: count outbox rows for a contact (as superuser, bypasses RLS)
// ---------------------------------------------------------------------------
async function countOutboxRows(contactId: string): Promise<number> {
  return db.adminQuery(async (tx) => {
    const rows = await tx
      .select()
      .from(contactLeadOutboxTable)
      .where(rawSql`contact_id = ${contactId}::uuid`);
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// Helper: get routed_at for a contact (as superuser)
// ---------------------------------------------------------------------------
async function getRoutedAt(contactId: string): Promise<Date | null> {
  return db.adminQuery(async (tx) => {
    const rows = await tx
      .select({ routedAt: contactsTable.routedAt })
      .from(contactsTable)
      .where(rawSql`id = ${contactId}::uuid`);
    return rows[0]?.routedAt ?? null;
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: Happy path — service level
// ---------------------------------------------------------------------------

describe('routeContact — happy path', () => {
  it('returns ok(lead) with routed_at set and exactly one outbox row', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: 'Ana García' });

    // Get the contact id
    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    const result = await routeContact(db.withTenant, TENANT_A, contact.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lead = result.value;

    // ContactLead validates against contractLeadSchema
    const parsed = contactLeadSchema.safeParse(lead);
    expect(parsed.success).toBe(true);

    // Correct field mapping
    expect(lead.external_id).toBe(contact.id);
    expect(lead.source).toBe('whatsapp');
    expect(lead.full_name).toBe('Ana García');
    expect(lead.tenant_id).toBe(TENANT_A);
    expect(typeof lead.captured_at).toBe('string');

    // routed_at set in DB
    const routedAt = await getRoutedAt(contact.id);
    expect(routedAt).not.toBeNull();
    expect(routedAt).toBeInstanceOf(Date);

    // Exactly ONE outbox row
    const count = await countOutboxRows(contact.id);
    expect(count).toBe(1);

    // Outbox row has correct payload and status
    const outboxRows = await db.adminQuery((tx) =>
      tx.select().from(contactLeadOutboxTable).where(rawSql`contact_id = ${contact.id}::uuid`),
    );
    const outboxRow = outboxRows[0];
    expect(outboxRow).toBeDefined();
    expect(outboxRow?.status).toBe('pending');
    expect(outboxRow?.payload).toMatchObject({ external_id: contact.id, source: 'whatsapp' });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Not found — random UUID
// ---------------------------------------------------------------------------

describe('routeContact — not found', () => {
  it('returns CONTACT_NOT_FOUND for a random UUID with zero outbox rows', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const result = await routeContact(db.withTenant, TENANT_A, fakeId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTACT_NOT_FOUND');

    const count = await countOutboxRows(fakeId);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Soft-deleted = not found
// ---------------------------------------------------------------------------

describe('routeContact — soft-deleted is not found', () => {
  it('returns CONTACT_NOT_FOUND for a soft-deleted contact', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: 'Deleted User' });

    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    // Soft-delete via admin
    await db.adminQuery((tx) =>
      tx
        .update(contactsTable)
        .set({ deletedAt: new Date() })
        .where(rawSql`id = ${contact.id}::uuid`),
    );

    const result = await routeContact(db.withTenant, TENANT_A, contact.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTACT_NOT_FOUND');

    const count = await countOutboxRows(contact.id);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Null full_name → MISSING_FULL_NAME
// ---------------------------------------------------------------------------

describe('routeContact — null full_name', () => {
  it('returns MISSING_FULL_NAME, leaves routed_at null, zero outbox rows', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: null });

    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    const result = await routeContact(db.withTenant, TENANT_A, contact.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MISSING_FULL_NAME');

    const routedAt = await getRoutedAt(contact.id);
    expect(routedAt).toBeNull();

    const count = await countOutboxRows(contact.id);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: No-op idempotency — already routed
// ---------------------------------------------------------------------------

describe('routeContact — idempotent no-op', () => {
  it('returns ok on second route, still exactly ONE outbox row, routed_at unchanged', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: 'Idempotent User' });

    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    // First route
    const result1 = await routeContact(db.withTenant, TENANT_A, contact.id);
    expect(result1.ok).toBe(true);

    const routedAtAfterFirst = await getRoutedAt(contact.id);
    expect(routedAtAfterFirst).not.toBeNull();

    // Brief pause so we'd see a timestamp change if no-op were broken
    await new Promise((r) => setTimeout(r, 50));

    // Second route (no-op)
    const result2 = await routeContact(db.withTenant, TENANT_A, contact.id);
    expect(result2.ok).toBe(true);

    // Still exactly ONE outbox row
    const count = await countOutboxRows(contact.id);
    expect(count).toBe(1);

    // routed_at unchanged (same timestamp)
    const routedAtAfterSecond = await getRoutedAt(contact.id);
    expect(routedAtAfterSecond?.getTime()).toBe(routedAtAfterFirst?.getTime());
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Tenant isolation — outbox RLS
// ---------------------------------------------------------------------------

describe('routeContact — tenant isolation', () => {
  it('outbox row written under tenant A is invisible to tenant B (RLS)', async () => {
    // Seed contacts for A and B
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: 'Tenant A Contact' });
    await db.seedTenant(TENANT_B, { phoneE164: PHONE_B, fullName: 'Tenant B Contact' });

    const contactsA = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contactA = contactsA[0];
    const contactsB = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_B}`),
    );
    const contactB = contactsB[0];
    expect(contactA).toBeDefined();
    expect(contactB).toBeDefined();
    if (!contactA || !contactB) return;

    // Route tenant A's contact
    const routeResult = await routeContact(db.withTenant, TENANT_A, contactA.id);
    expect(routeResult.ok).toBe(true);

    // Tenant B sees zero outbox rows (RLS blocks cross-tenant read)
    const rowsSeenByB = await db.withTenant(TENANT_B, async (tx) => {
      return tx.select().from(contactLeadOutboxTable);
    });
    expect(rowsSeenByB).toHaveLength(0);

    // Routing B's id under tenant A → CONTACT_NOT_FOUND (RLS hides B's row from A)
    const wrongTenantResult = await routeContact(db.withTenant, TENANT_A, contactB.id);
    expect(wrongTenantResult.ok).toBe(false);
    if (wrongTenantResult.ok) return;
    expect(wrongTenantResult.error.code).toBe('CONTACT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Negative atomicity — rollback test
// MANDATORY per canonical contract (Correction 1)
// Mechanism: REVOKE INSERT ON contact_lead_outbox FROM app_rls via adminQuery,
// attempt route (INSERT fails → permission denied → tx rolls back), assert
// routed_at stays null AND zero outbox rows, then GRANT INSERT back.
// ---------------------------------------------------------------------------

describe('routeContact — negative atomicity (rollback)', () => {
  it('rolls back routed_at and outbox INSERT together on INSERT failure', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_C, fullName: 'Rollback Test User' });

    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_C}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    // Revoke INSERT from app_rls so the outbox INSERT will fail with permission denied
    await db.adminQuery(async (tx) => {
      await tx.execute(rawSql`REVOKE INSERT ON contact_lead_outbox FROM app_rls`);
    });

    try {
      // Attempt to route — UPDATE routed_at succeeds but INSERT into outbox fails → rollback
      const result = await routeContact(db.withTenant, TENANT_A, contact.id);

      // The outer .catch() in routeContact maps the thrown permission error to DB_ERROR
      expect(result.ok).toBe(false);
      if (result.ok) {
        // Restore grant before failing assertion
        await db.adminQuery(async (tx) => {
          await tx.execute(rawSql`GRANT INSERT ON contact_lead_outbox TO app_rls`);
        });
        expect(result.ok).toBe(false); // force fail with message
        return;
      }
      expect(result.error.code).toBe('DB_ERROR');

      // routed_at MUST still be null (UPDATE was rolled back)
      const routedAt = await getRoutedAt(contact.id);
      expect(routedAt).toBeNull();

      // ZERO outbox rows (INSERT was rolled back)
      const count = await countOutboxRows(contact.id);
      expect(count).toBe(0);
    } finally {
      // Always restore the grant so subsequent tests work
      await db.adminQuery(async (tx) => {
        await tx.execute(rawSql`GRANT INSERT ON contact_lead_outbox TO app_rls`);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7b: Outbox payload validates against contactLeadSchema
// ---------------------------------------------------------------------------

describe('routeContact — outbox payload schema conformance', () => {
  it('stored payload validates against contactLeadSchema', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: 'Schema Test User' });

    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    await routeContact(db.withTenant, TENANT_A, contact.id);

    const outboxRows = await db.adminQuery((tx) =>
      tx.select().from(contactLeadOutboxTable).where(rawSql`contact_id = ${contact.id}::uuid`),
    );
    const outboxRow = outboxRows[0];
    expect(outboxRow).toBeDefined();

    const parsed = contactLeadSchema.safeParse(outboxRow?.payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBe('whatsapp');
      expect(parsed.data.external_id).toBe(contact.id);
      expect(typeof parsed.data.captured_at).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP-layer scenarios: POST /contacts/:id/route
// ---------------------------------------------------------------------------

describe('POST /contacts/:id/route — HTTP layer', () => {
  it('200 — routes a valid named contact, returns { routed: ContactLead }', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: 'HTTP Test User' });

    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    const res = await app.request(`/contacts/${contact.id}/route`, {
      method: 'POST',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.routed).toBeDefined();
    const routed = body.routed as Record<string, unknown>;
    expect(routed.source).toBe('whatsapp');
    expect(routed.external_id).toBe(contact.id);
    expect(typeof routed.captured_at).toBe('string');

    // Verify DB state
    const routedAt = await getRoutedAt(contact.id);
    expect(routedAt).not.toBeNull();
    const count = await countOutboxRows(contact.id);
    expect(count).toBe(1);
  });

  it('200 — no-op on second call, still one outbox row', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: 'Noop HTTP User' });

    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    // First call
    await app.request(`/contacts/${contact.id}/route`, {
      method: 'POST',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    // Second call — no-op
    const res2 = await app.request(`/contacts/${contact.id}/route`, {
      method: 'POST',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res2.status).toBe(200);
    const count = await countOutboxRows(contact.id);
    expect(count).toBe(1);
  });

  it('404 — non-existent contact id returns CONTACT_NOT_FOUND', async () => {
    const res = await app.request('/contacts/00000000-0000-0000-0000-000000000000/route', {
      method: 'POST',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('CONTACT_NOT_FOUND');
  });

  it('422 — contact with null full_name returns MISSING_FULL_NAME', async () => {
    await db.seedTenant(TENANT_A, { phoneE164: PHONE_A, fullName: null });

    const contacts = await db.adminQuery((tx) =>
      tx.select().from(contactsTable).where(rawSql`phone_e164 = ${PHONE_A}`),
    );
    const contact = contacts[0];
    expect(contact).toBeDefined();
    if (!contact) return;

    const res = await app.request(`/contacts/${contact.id}/route`, {
      method: 'POST',
      headers: { 'X-Tenant-Id': TENANT_A },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('MISSING_FULL_NAME');
  });
});
