/**
 * tenant-ai-config.repo.int.test.ts — Integration tests for getTenantAiConfig.
 *
 * All assertions run through the app_rls-scoped TenantRunner (RLS enforced).
 * Uses Testcontainers (postgres:16-alpine + all 5 migrations including 0004).
 *
 * Strict TDD: this file was written RED (before the implementation exists).
 *
 * Scenarios:
 * - ok(null) when no row exists for the tenant
 * - ok(null) when a row exists but enabled=false
 * - ok(null) when a row exists but deleted_at is set
 * - ok(row) when exactly one active enabled row exists
 * - err(MULTIPLE_CONFIGS) when two active enabled rows exist
 * - RLS isolation: tenant B cannot read tenant A config
 */

import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTenantAiConfig } from '../../src/ai/tenant-ai-config.repository.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

type AiConfigSeedParams = {
  tenantId: string;
  vertical?: string;
  businessName?: string;
  enabled?: boolean;
  deletedAt?: Date | null;
};

/**
 * Inserts a tenant_ai_config row directly via adminSql (bypasses RLS).
 */
async function seedAiConfig(db: TestDb, params: AiConfigSeedParams): Promise<void> {
  const {
    tenantId,
    vertical = 'tienda_general',
    businessName = 'Test Business',
    enabled = true,
    deletedAt = null,
  } = params;

  await db.adminQuery(async (tx) => {
    await tx.execute(
      rawSql`
        INSERT INTO tenant_ai_config
          (tenant_id, vertical, business_name, business_info, enabled, deleted_at)
        VALUES
          (${tenantId}::uuid, ${vertical}, ${businessName}, '{}', ${enabled}, ${deletedAt})
      `,
    );
  });
}

// ---------------------------------------------------------------------------
// getTenantAiConfig
// ---------------------------------------------------------------------------

describe('getTenantAiConfig', () => {
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

  it('returns ok(null) when no row exists for the tenant', async () => {
    const result = await getTenantAiConfig(db.withTenant, TENANT_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns ok(null) when a row exists but enabled=false', async () => {
    await seedAiConfig(db, { tenantId: TENANT_A, enabled: false });

    const result = await getTenantAiConfig(db.withTenant, TENANT_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns ok(null) when a row exists but deleted_at is set (soft-deleted)', async () => {
    await seedAiConfig(db, { tenantId: TENANT_A, deletedAt: new Date('2024-01-01T00:00:00Z') });

    const result = await getTenantAiConfig(db.withTenant, TENANT_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns ok(row) when exactly one active enabled row exists', async () => {
    await seedAiConfig(db, {
      tenantId: TENANT_A,
      vertical: 'tienda_general',
      businessName: 'Mi Tienda',
      enabled: true,
    });

    const result = await getTenantAiConfig(db.withTenant, TENANT_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBeNull();
    const config = result.value;
    expect(config?.tenantId).toBe(TENANT_A);
    expect(config?.vertical).toBe('tienda_general');
    expect(config?.businessName).toBe('Mi Tienda');
    expect(config?.enabled).toBe(true);
    expect(config?.deletedAt).toBeNull();
    expect(typeof config?.id).toBe('string');
    expect(config?.createdAt).toBeInstanceOf(Date);
  });

  it('returns err(MULTIPLE_CONFIGS) when two active enabled rows exist', async () => {
    await seedAiConfig(db, { tenantId: TENANT_A, vertical: 'tienda_general' });
    await seedAiConfig(db, { tenantId: TENANT_A, vertical: 'tienda_premium' });

    const result = await getTenantAiConfig(db.withTenant, TENANT_A);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MULTIPLE_CONFIGS');
  });

  it('is RLS-isolated: tenant B cannot read tenant A config', async () => {
    await seedAiConfig(db, { tenantId: TENANT_A, businessName: 'Tenant A Business' });

    // Query as TENANT_B — RLS should prevent seeing TENANT_A rows
    const result = await getTenantAiConfig(db.withTenant, TENANT_B);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns only the active enabled row when one disabled row also exists', async () => {
    await seedAiConfig(db, { tenantId: TENANT_A, businessName: 'Active', enabled: true });
    await seedAiConfig(db, { tenantId: TENANT_A, businessName: 'Disabled', enabled: false });

    const result = await getTenantAiConfig(db.withTenant, TENANT_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.businessName).toBe('Active');
  });
});
