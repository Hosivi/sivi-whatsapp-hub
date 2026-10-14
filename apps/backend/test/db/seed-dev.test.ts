/**
 * seed-dev.test.ts — Integration tests for the idempotent dev seed.
 *
 * Uses Testcontainers (PG16) with admin client.
 *
 * Tests:
 * (a) run seed once → exactly one row in whatsapp_accounts for the configured
 *     phone_number_id with deleted_at = NULL
 * (b) run seed a second time → still exactly one row, no error thrown
 * (c) the seeded tenant_ai_config row leaves the AI switched off (enabled = false)
 * (d) one tenant_reply_settings row with the dev business name and hours text
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantAiConfigTable } from '../../src/db/schema/tenant-ai-config.schema.js';
import { whatsappAccountsTable } from '../../src/db/schema/whatsapp-accounts.schema.js';
import {
  DEV_AI_BUSINESS_INFO,
  DEV_AI_BUSINESS_NAME,
  DEV_AI_VERTICAL,
  DEV_PHONE_NUMBER_ID,
  DEV_TENANT_ID,
  runDevSeed,
} from '../../src/db/seed-dev.js';
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

  it('(c) seeds exactly one dev tenant_ai_config row with the AI switched off', async () => {
    // Already seeded in (a) and (b).
    const configs = await db.adminQuery((tx) =>
      tx.select().from(tenantAiConfigTable).where(eq(tenantAiConfigTable.tenantId, DEV_TENANT_ID)),
    );

    expect(configs.length).toBe(1);
    expect(configs[0]?.vertical).toBe(DEV_AI_VERTICAL);
    expect(configs[0]?.enabled).toBe(false);
  });

  it('(d) seeds exactly one dev tenant_reply_settings row with the business name and hours', async () => {
    // Already seeded twice in (a) and (b): the row must not be duplicated.
    const rows = await db.adminSql<
      { business_name: string | null; hours_text: string | null; enabled: boolean }[]
    >`
      SELECT business_name, hours_text, enabled
      FROM tenant_reply_settings
      WHERE tenant_id = ${DEV_TENANT_ID}::uuid AND deleted_at IS NULL
    `;

    expect(rows).toEqual([
      {
        business_name: DEV_AI_BUSINESS_NAME,
        hours_text: DEV_AI_BUSINESS_INFO.hours,
        enabled: true,
      },
    ]);
  });

  it('exports DEV_TENANT_ID and DEV_PHONE_NUMBER_ID as non-empty strings', () => {
    expect(typeof DEV_TENANT_ID).toBe('string');
    expect(DEV_TENANT_ID.length).toBeGreaterThan(0);
    expect(typeof DEV_PHONE_NUMBER_ID).toBe('string');
    expect(DEV_PHONE_NUMBER_ID.length).toBeGreaterThan(0);
  });
});
