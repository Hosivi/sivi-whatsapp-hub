/**
 * seed-dev.test.ts — Integration tests for the idempotent dev seed.
 *
 * Uses Testcontainers (PG16) with admin client.
 *
 * Tests:
 * (a) run seed once → exactly one row in whatsapp_accounts for the configured
 *     phone_number_id with deleted_at = NULL
 * (b) run seed a second time → still exactly one row, no error thrown
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whatsappAccountsTable } from '../../src/db/schema/whatsapp-accounts.schema.js';
import { DEV_PHONE_NUMBER_ID, DEV_TENANT_ID, runDevSeed } from '../../src/db/seed-dev.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('seed-dev (idempotent)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('(a) run once → exactly one row with phone_number_id = DEV_PHONE_NUMBER_ID and deleted_at = NULL', async () => {
    await runDevSeed(db.adminSql);

    const rows = await db.adminQuery((tx) =>
      tx
        .select()
        .from(whatsappAccountsTable)
        .where(eq(whatsappAccountsTable.phoneNumberId, DEV_PHONE_NUMBER_ID)),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.tenantId).toBe(DEV_TENANT_ID);
    expect(rows[0]?.deletedAt).toBeNull();
    expect(rows[0]?.accessToken).toBe('dev-access-token');
  });

  it('(b) run twice → still exactly one row, no error thrown, access_token preserved', async () => {
    // Already seeded once in (a). Run again.
    await expect(runDevSeed(db.adminSql)).resolves.not.toThrow();

    const rows = await db.adminQuery((tx) =>
      tx
        .select()
        .from(whatsappAccountsTable)
        .where(eq(whatsappAccountsTable.phoneNumberId, DEV_PHONE_NUMBER_ID)),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.accessToken).toBe('dev-access-token');
  });

  it('exports DEV_TENANT_ID and DEV_PHONE_NUMBER_ID as non-empty strings', () => {
    expect(typeof DEV_TENANT_ID).toBe('string');
    expect(DEV_TENANT_ID.length).toBeGreaterThan(0);
    expect(typeof DEV_PHONE_NUMBER_ID).toBe('string');
    expect(DEV_PHONE_NUMBER_ID.length).toBeGreaterThan(0);
  });
});
