/**
 * test-db-whatsapp.int.test.ts — Verifies the new test-db helpers for WhatsApp.
 *
 * Tests:
 * - seedWhatsappAccount inserts a row visible via adminQuery
 * - app_webhook connection resolves the seeded row via resolveTenant (via DbClient)
 * - truncate() clears whatsapp_messages and whatsapp_accounts
 *
 * Uses Testcontainers (full 3-migration stack via createTestDb).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PHONE_NUMBER_ID = 'pnid-seed-test-001';

describe('test-db seedWhatsappAccount + app_webhook resolution', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('seedWhatsappAccount inserts a row retrievable via adminQuery', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51987654321',
      wabaId: 'waba-001',
    });

    const rows = await db.adminQuery(async (tx) => {
      const { sql } = await import('drizzle-orm');
      return tx.execute(
        sql`SELECT phone_number_id, tenant_id FROM whatsapp_accounts WHERE phone_number_id = ${PHONE_NUMBER_ID}`,
      );
    });

    expect(rows.rows ?? rows).toHaveLength(1);
  });

  it('app_webhook connection can resolve tenant from seeded account', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51987654321',
      wabaId: 'waba-001',
    });

    const result = await db.resolveWebhookTenant(PHONE_NUMBER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(TENANT_A);
  });

  it('resolveWebhookTenant returns err for unknown phone_number_id', async () => {
    const result = await db.resolveWebhookTenant('nonexistent-pnid');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNKNOWN_PHONE_NUMBER_ID');
  });

  it('truncate() clears whatsapp_accounts rows', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51987654321',
      wabaId: 'waba-001',
    });

    await db.truncate();

    const rows = await db.adminQuery(async (tx) => {
      const { sql } = await import('drizzle-orm');
      return tx.execute(sql`SELECT phone_number_id FROM whatsapp_accounts`);
    });

    expect(rows.rows ?? rows).toHaveLength(0);
  });
});
