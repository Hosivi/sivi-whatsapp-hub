/**
 * rls.int.test.ts — Integration tests for RLS tenant isolation.
 *
 * These tests MUST run connected AS the non-superuser app_rls role.
 * If the test suite connected as the superuser, RLS would be bypassed and
 * every assertion would trivially pass — proving nothing.
 *
 * Requires Docker (Testcontainers spins up postgres:16-alpine).
 * testTimeout/hookTimeout are set in vitest.config.ts (60s/120s).
 *
 * Scenarios:
 * (a) withTenant(A) SELECT returns only tenant A rows, not tenant B.
 * (b) withTenant(A) INSERT with tenant_id=B is rejected by WITH CHECK.
 * (c) Connected as app_rls (not superuser): RLS is enforced, not bypassed.
 * (d) withTenant(A) UPDATE of a tenant B row → 0 rows affected.
 * (e) No SET LOCAL → empty result (default-deny).
 */

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactsTable } from '../../src/db/schema/contacts.schema.js';
import { type TestDb, createTestDb } from '../_helpers/test-db.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('RLS — tenant isolation (connected as app_rls)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    // Seed: one contact per tenant
    await db.seedTenant(TENANT_A, {
      phoneE164: '+51987000001',
      fullName: 'Tenant A Contact',
    });
    await db.seedTenant(TENANT_B, {
      phoneE164: '+51987000002',
      fullName: 'Tenant B Contact',
    });
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('(a) withTenant(A): SELECT returns only tenant A rows, not tenant B rows', async () => {
    const rows = await db.withTenant(TENANT_A, async (tx) => {
      return tx.select().from(contactsTable);
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
    const tenantBRow = rows.find((r) => r.tenantId === TENANT_B);
    expect(tenantBRow).toBeUndefined();
  });

  it('(b) withTenant(A): INSERT with tenant_id=B is rejected by WITH CHECK', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        await tx.insert(contactsTable).values({
          tenantId: TENANT_B, // foreign tenant — should be blocked by WITH CHECK
          phoneE164: '+51987999999',
        });
      }),
    ).rejects.toThrow();
  });

  it('(c) Connected as app_rls (not superuser): RLS is enforced, not bypassed', async () => {
    // This is implicitly proven by (a) — the test helper connects as app_rls.
    // We add an explicit assertion here to document the invariant.
    const rows = await db.withTenant(TENANT_B, async (tx) => {
      return tx.select().from(contactsTable);
    });
    // Should see ONLY tenant B's row, not tenant A's
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_B);
  });

  it('(d) withTenant(A): UPDATE of tenant B row → 0 rows affected', async () => {
    // Get tenant B's row id using admin connection (bypasses RLS)
    const adminRows = await db.adminQuery(async (tx) => {
      return tx
        .select({ id: contactsTable.id })
        .from(contactsTable)
        .where(eq(contactsTable.tenantId, TENANT_B));
    });
    const tenantBId = adminRows[0]?.id;
    expect(tenantBId).toBeDefined();

    // Try to update tenant B's row while tenant context is A
    // tenantBId is guaranteed defined by the expect above
    const safeId = tenantBId ?? '';
    const result = await db.withTenant(TENANT_A, async (tx) => {
      return tx
        .update(contactsTable)
        .set({ fullName: 'Hacked' })
        .where(eq(contactsTable.id, safeId))
        .returning();
    });

    // RLS hides the row: 0 rows affected, no error raised
    expect(result).toHaveLength(0);
  });

  it('(e) No SET LOCAL → query returns empty (default-deny)', async () => {
    // Connect directly as app_rls without setting app.current_tenant
    const appRlsSql = postgres(db.appRlsConnectionString, { max: 1 });
    const appRlsDb = drizzle(appRlsSql);

    try {
      // No withTenant → no SET LOCAL → RLS sees current_setting() as '' or null
      const rows = await appRlsDb.select().from(contactsTable);
      expect(rows).toHaveLength(0);
    } finally {
      await appRlsSql.end();
    }
  });
});
