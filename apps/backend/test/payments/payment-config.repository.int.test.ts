/**
 * payment-config.repository.int.test.ts — Integration tests for createPaymentConfigRepository.
 *
 * All assertions run through the app_rls-scoped TenantRunner (RLS enforced).
 * Uses Testcontainers (postgres:16-alpine + all 6 migrations including 0005).
 *
 * STRICT TDD — test written RED before implementation.
 *
 * Scenarios:
 * (a) find returns ok(null) when no config exists for tenant
 * (b) save inserts a config row (configured=true)
 * (c) save upserts — second save with same provider updates the row
 * (d) save resurrects a soft-deleted config
 * (e) find returns the active config after save
 * (f) find returns ok(null) after soft-delete (deletedAt set by admin)
 * (g) RLS isolation — tenant B cannot read tenant A config
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantPaymentConfigTable } from '../../src/db/schema/tenant-payment-config.schema.js';
import { createPaymentConfigRepository } from '../../src/payments/payment-config.repository.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Seed helper (admin — bypasses RLS for test setup)
// ---------------------------------------------------------------------------

type SeedConfigParams = {
  tenantId: string;
  provider?: string;
  configured?: boolean;
  publicKey?: string | null;
  deletedAt?: Date | null;
};

async function seedConfig(db: TestDb, params: SeedConfigParams) {
  const {
    tenantId,
    provider = 'culqi',
    configured = true,
    publicKey = null,
    deletedAt = null,
  } = params;

  const rows = await db.adminQuery(async (tx) => {
    return tx
      .insert(tenantPaymentConfigTable)
      .values({
        tenantId,
        provider,
        configured,
        publicKey,
        deletedAt: deletedAt ?? undefined,
      })
      .returning();
  });

  const row = rows[0];
  if (!row) throw new Error('seed failed');
  return row;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createPaymentConfigRepository', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  // ------------------------------------------------------------------
  // (a) find — no config
  // ------------------------------------------------------------------
  it('(a) find returns ok(null) when no config exists for the tenant', async () => {
    const repo = createPaymentConfigRepository(db.withTenant, TENANT_A);
    const result = await repo.find();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value).toBeNull();
  });

  // ------------------------------------------------------------------
  // (b) save — insert
  // ------------------------------------------------------------------
  it('(b) save inserts a config row and returns ok(config)', async () => {
    const repo = createPaymentConfigRepository(db.withTenant, TENANT_A);
    const saveResult = await repo.save({
      provider: 'culqi',
      configured: true,
      publicKey: 'pk_test_abc123',
    });

    expect(saveResult.ok).toBe(true);
    if (!saveResult.ok) throw new Error('never');

    const config = saveResult.value;
    expect(config.tenantId).toBe(TENANT_A);
    expect(config.provider).toBe('culqi');
    expect(config.configured).toBe(true);
    expect(config.publicKey).toBe('pk_test_abc123');
    expect(config.deletedAt).toBeNull();
    expect(typeof config.id).toBe('string');
    expect(config.createdAt).toBeInstanceOf(Date);
  });

  // ------------------------------------------------------------------
  // (c) save upsert — second save updates the same row
  // ------------------------------------------------------------------
  it('(c) save upserts: second call with same provider updates the existing row', async () => {
    const repo = createPaymentConfigRepository(db.withTenant, TENANT_A);

    const first = await repo.save({ provider: 'culqi', configured: false });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('never');
    const firstId = first.value.id;

    const second = await repo.save({
      provider: 'culqi',
      configured: true,
      publicKey: 'pk_live_xyz',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('never');
    // Same row updated, not a new row
    expect(second.value.id).toBe(firstId);
    expect(second.value.configured).toBe(true);
    expect(second.value.publicKey).toBe('pk_live_xyz');
  });

  // ------------------------------------------------------------------
  // (d) save resurrects a soft-deleted row
  // ------------------------------------------------------------------
  it('(d) save resurrects a soft-deleted config row', async () => {
    // Seed a soft-deleted row directly via admin
    await seedConfig(db, { tenantId: TENANT_A, deletedAt: new Date('2024-01-01T00:00:00Z') });

    const repo = createPaymentConfigRepository(db.withTenant, TENANT_A);
    const result = await repo.save({ provider: 'culqi', configured: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    // Row is resurrected — deletedAt is now null
    expect(result.value.deletedAt).toBeNull();
    expect(result.value.configured).toBe(true);
  });

  // ------------------------------------------------------------------
  // (e) find returns config after save
  // ------------------------------------------------------------------
  it('(e) find returns the active config after save', async () => {
    const repo = createPaymentConfigRepository(db.withTenant, TENANT_A);
    await repo.save({ provider: 'culqi', configured: true, publicKey: 'pk_test_find' });

    const result = await repo.find();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value).not.toBeNull();
    expect(result.value?.provider).toBe('culqi');
    expect(result.value?.configured).toBe(true);
    expect(result.value?.publicKey).toBe('pk_test_find');
  });

  // ------------------------------------------------------------------
  // (f) find returns ok(null) when row is soft-deleted
  // ------------------------------------------------------------------
  it('(f) find returns ok(null) when the config row is soft-deleted', async () => {
    // Seed a soft-deleted row
    await seedConfig(db, { tenantId: TENANT_A, deletedAt: new Date('2024-06-01T00:00:00Z') });

    const repo = createPaymentConfigRepository(db.withTenant, TENANT_A);
    const result = await repo.find();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value).toBeNull();
  });

  // ------------------------------------------------------------------
  // (g) RLS isolation — tenant B cannot read tenant A config
  // ------------------------------------------------------------------
  it('(g) RLS isolation: tenant B cannot read tenant A config', async () => {
    // Seed a config for tenant A directly via admin (bypasses RLS).
    await seedConfig(db, { tenantId: TENANT_A, configured: true });

    // Query as tenant B — RLS should hide tenant A rows.
    const repoB = createPaymentConfigRepository(db.withTenant, TENANT_B);
    const result = await repoB.find();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value).toBeNull();
  });
});
