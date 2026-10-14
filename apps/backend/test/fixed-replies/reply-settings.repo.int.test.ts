/**
 * reply-settings.repo.int.test.ts — Integration tests for tenant_reply_settings.
 *
 * Testcontainers (postgres:16-alpine + all migrations). Reads go through the
 * app_rls-scoped TenantRunner (RLS enforced); setup uses the admin handle.
 *
 * Covers:
 * - getReplySettings: no row → ok(null); live row → ok(settings); soft-deleted → ok(null)
 * - enabled defaults to true when not supplied
 * - RLS: tenant B cannot read tenant A's row
 * - RLS: an insert for another tenant is rejected by WITH CHECK
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantReplySettingsTable } from '../../src/db/schema/tenant-reply-settings.schema.js';
import { getReplySettings } from '../../src/fixed-replies/reply-settings.repository.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('tenant_reply_settings (Testcontainers)', () => {
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

  it('getReplySettings returns ok(null) when the tenant has no row', async () => {
    expect(await getReplySettings(db.withTenant, TENANT_A)).toEqual({ ok: true, value: null });
  });

  it('getReplySettings returns the live row of the tenant', async () => {
    await db.adminSql`
      INSERT INTO tenant_reply_settings
        (tenant_id, business_name, greeting_text, hours_text, handoff_text, enabled)
      VALUES
        (${TENANT_A}::uuid, 'Bodega Rosa', 'Hola desde {negocio}', 'lunes a sábado',
         'Ya te atendemos', false)
    `;

    const result = await getReplySettings(db.withTenant, TENANT_A);

    expect(result).toEqual({
      ok: true,
      value: {
        businessName: 'Bodega Rosa',
        greetingText: 'Hola desde {negocio}',
        hoursText: 'lunes a sábado',
        handoffText: 'Ya te atendemos',
        enabled: false,
      },
    });
  });

  it('ignores a soft-deleted row', async () => {
    await db.adminSql`
      INSERT INTO tenant_reply_settings (tenant_id, business_name, deleted_at)
      VALUES (${TENANT_A}::uuid, 'Borrada', now())
    `;

    expect(await getReplySettings(db.withTenant, TENANT_A)).toEqual({ ok: true, value: null });
  });

  it('defaults enabled to true and every text column to NULL', async () => {
    await db.adminSql`INSERT INTO tenant_reply_settings (tenant_id) VALUES (${TENANT_A}::uuid)`;

    expect(await getReplySettings(db.withTenant, TENANT_A)).toEqual({
      ok: true,
      value: {
        businessName: null,
        greetingText: null,
        hoursText: null,
        handoffText: null,
        enabled: true,
      },
    });
  });

  it('allows at most one live row per tenant', async () => {
    await db.adminSql`INSERT INTO tenant_reply_settings (tenant_id) VALUES (${TENANT_A}::uuid)`;

    await expect(
      db.adminSql`INSERT INTO tenant_reply_settings (tenant_id) VALUES (${TENANT_A}::uuid)`,
    ).rejects.toThrow(/duplicate key/i);
  });

  it('RLS: tenant B cannot read tenant A row', async () => {
    await db.adminSql`
      INSERT INTO tenant_reply_settings (tenant_id, business_name)
      VALUES (${TENANT_A}::uuid, 'Solo de A')
    `;

    const rowsB = await db.withTenant(TENANT_B, (tx) => tx.select().from(tenantReplySettingsTable));
    expect(rowsB).toHaveLength(0);
    expect(await getReplySettings(db.withTenant, TENANT_B)).toEqual({ ok: true, value: null });

    const rowsA = await db.withTenant(TENANT_A, (tx) => tx.select().from(tenantReplySettingsTable));
    expect(rowsA).toHaveLength(1);
  });

  it('RLS: an insert for another tenant is rejected by WITH CHECK', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        await tx.insert(tenantReplySettingsTable).values({
          tenantId: TENANT_B, // foreign tenant — blocked by WITH CHECK
          businessName: 'Intruso',
        });
      }),
    ).rejects.toThrow();

    const all = await db.adminSql`SELECT id FROM tenant_reply_settings`;
    expect(all).toHaveLength(0);
  });
});
