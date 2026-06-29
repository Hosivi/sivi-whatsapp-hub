/**
 * payments.repository.int.test.ts — Integration tests for createPaymentsRepository.
 *
 * All assertions run through the app_rls-scoped TenantRunner (RLS enforced).
 * Uses Testcontainers (postgres:16-alpine + all 6 migrations including 0005).
 *
 * STRICT TDD — test written RED before implementation.
 *
 * Scenarios:
 * (a) createRecord inserts a row with status='pending'
 * (b) createRecord stores all optional fields (source entity, metadata)
 * (c) markPaid transitions pending→paid, returns rowCount=1
 * (d) markPaid second call returns rowCount=0 (idempotent — no re-transition)
 * (e) findById returns the payment; returns null for unknown id
 * (f) findByReference returns the payment; returns null for unknown reference
 * (g) RLS isolation — tenant B cannot read tenant A payments (sees zero rows)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentsTable } from '../../src/db/schema/payments.schema.js';
import { createPaymentsRepository } from '../../src/payments/payments.repository.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

type SeedPaymentParams = {
  tenantId: string;
  externalId?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  status?: string;
};

async function seedPayment(db: TestDb, params: SeedPaymentParams) {
  const {
    tenantId,
    externalId = `ext-${Date.now()}-${Math.random()}`,
    reference = 'order-001',
    amount = 1000,
    currency = 'PEN',
    status = 'pending',
  } = params;

  const rows = await db.adminQuery(async (tx) => {
    return tx
      .insert(paymentsTable)
      .values({
        tenantId,
        externalId,
        reference,
        amount,
        currency,
        status,
        metadata: { tenantId, paymentId: 'pay-seed-001' },
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

describe('createPaymentsRepository', () => {
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
  // (a) createRecord — basic insert
  // ------------------------------------------------------------------
  it('(a) createRecord inserts a row with status=pending', async () => {
    const repo = createPaymentsRepository(db.withTenant, TENANT_A);
    const result = await repo.createRecord({
      externalId: 'ext-001',
      reference: 'order-001',
      amount: 1500,
      currency: 'PEN',
      metadata: { tenantId: TENANT_A, paymentId: 'pay-001' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');

    const payment = result.value;
    expect(payment.status).toBe('pending');
    expect(payment.amount).toBe(1500);
    expect(payment.currency).toBe('PEN');
    expect(payment.externalId).toBe('ext-001');
    expect(payment.reference).toBe('order-001');
    expect(payment.tenantId).toBe(TENANT_A);
    expect(payment.paidAt).toBeNull();
    expect(payment.deletedAt).toBeNull();
    expect(typeof payment.id).toBe('string');
    expect(payment.createdAt).toBeInstanceOf(Date);
  });

  // ------------------------------------------------------------------
  // (b) createRecord stores optional fields
  // ------------------------------------------------------------------
  it('(b) createRecord stores source entity fields and metadata', async () => {
    const repo = createPaymentsRepository(db.withTenant, TENANT_A);
    const SOURCE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const result = await repo.createRecord({
      externalId: 'ext-002',
      reference: 'order-002',
      amount: 2000,
      currency: 'USD',
      sourceEntityType: 'contact',
      sourceEntityId: SOURCE_ID,
      metadata: { tenantId: TENANT_A, paymentId: 'pay-002', extra: true },
      rawGatewayResponse: { provider: 'culqi', status: 'created' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    const p = result.value;
    expect(p.sourceEntityType).toBe('contact');
    expect(p.sourceEntityId).toBe(SOURCE_ID);
    expect(p.metadata).toEqual({ tenantId: TENANT_A, paymentId: 'pay-002', extra: true });
    expect(p.rawGatewayResponse).toEqual({ provider: 'culqi', status: 'created' });
  });

  // ------------------------------------------------------------------
  // (c) markPaid — first call transitions pending→paid, rowCount=1
  // ------------------------------------------------------------------
  it('(c) markPaid transitions pending→paid and returns rowCount=1', async () => {
    const repo = createPaymentsRepository(db.withTenant, TENANT_A);

    const createResult = await repo.createRecord({
      externalId: 'ext-003',
      reference: 'order-003',
      amount: 500,
      currency: 'PEN',
      metadata: { tenantId: TENANT_A, paymentId: 'pay-003' },
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) throw new Error('never');
    const { id } = createResult.value;

    const markResult = await repo.markPaid(id, { gateway: 'culqi', event: 'charge.paid' });
    expect(markResult.ok).toBe(true);
    if (!markResult.ok) throw new Error('never');
    expect(markResult.value.rowCount).toBe(1);

    // Verify the row is now paid
    const findResult = await repo.findById(id);
    expect(findResult.ok).toBe(true);
    if (!findResult.ok) throw new Error('never');
    expect(findResult.value?.status).toBe('paid');
    expect(findResult.value?.paidAt).toBeInstanceOf(Date);
  });

  // ------------------------------------------------------------------
  // (d) markPaid second call — idempotent, rowCount=0
  // ------------------------------------------------------------------
  it('(d) markPaid second call returns rowCount=0 (idempotent)', async () => {
    const repo = createPaymentsRepository(db.withTenant, TENANT_A);

    const createResult = await repo.createRecord({
      externalId: 'ext-004',
      reference: 'order-004',
      amount: 750,
      currency: 'PEN',
      metadata: { tenantId: TENANT_A, paymentId: 'pay-004' },
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) throw new Error('never');
    const { id } = createResult.value;

    // First mark — should succeed
    const first = await repo.markPaid(id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('never');
    expect(first.value.rowCount).toBe(1);

    // Second mark — row already paid, no UPDATE matched, rowCount=0
    const second = await repo.markPaid(id);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('never');
    expect(second.value.rowCount).toBe(0);
  });

  // ------------------------------------------------------------------
  // (e) findById
  // ------------------------------------------------------------------
  it('(e) findById returns payment by id; null for unknown id', async () => {
    const seeded = await seedPayment(db, { tenantId: TENANT_A, externalId: 'ext-find-001' });

    const repo = createPaymentsRepository(db.withTenant, TENANT_A);

    const found = await repo.findById(seeded.id);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error('never');
    expect(found.value?.id).toBe(seeded.id);
    expect(found.value?.externalId).toBe('ext-find-001');

    const notFound = await repo.findById('dddddddd-dddd-dddd-dddd-dddddddddddd');
    expect(notFound.ok).toBe(true);
    if (!notFound.ok) throw new Error('never');
    expect(notFound.value).toBeNull();
  });

  // ------------------------------------------------------------------
  // (f) findByReference
  // ------------------------------------------------------------------
  it('(f) findByReference returns payment by reference; null for unknown reference', async () => {
    await seedPayment(db, {
      tenantId: TENANT_A,
      externalId: 'ext-ref-001',
      reference: 'order-ref-001',
    });

    const repo = createPaymentsRepository(db.withTenant, TENANT_A);

    const found = await repo.findByReference('order-ref-001');
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error('never');
    expect(found.value?.reference).toBe('order-ref-001');

    const notFound = await repo.findByReference('does-not-exist');
    expect(notFound.ok).toBe(true);
    if (!notFound.ok) throw new Error('never');
    expect(notFound.value).toBeNull();
  });

  // ------------------------------------------------------------------
  // (g) RLS isolation — tenant B cannot read tenant A payments
  // ------------------------------------------------------------------
  it('(g) RLS isolation: tenant B cannot read tenant A payments', async () => {
    // Seed a payment for tenant A directly via admin (bypasses RLS).
    await seedPayment(db, {
      tenantId: TENANT_A,
      externalId: 'ext-rls-001',
      reference: 'rls-order-001',
    });

    // Query as tenant B — RLS should hide tenant A rows.
    const repoB = createPaymentsRepository(db.withTenant, TENANT_B);

    const byId = await db.adminQuery(async (tx) => {
      // Get the seeded ID first (as admin)
      const rows = await tx.select({ id: paymentsTable.id }).from(paymentsTable).limit(1);
      return rows[0]?.id;
    });

    if (!byId) throw new Error('seed row not found by admin');

    // Tenant B looking up tenant A's row ID → should get null (RLS hides it)
    const findResult = await repoB.findById(byId);
    expect(findResult.ok).toBe(true);
    if (!findResult.ok) throw new Error('never');
    expect(findResult.value).toBeNull();

    // Tenant B looking up by reference → null
    const refResult = await repoB.findByReference('rls-order-001');
    expect(refResult.ok).toBe(true);
    if (!refResult.ok) throw new Error('never');
    expect(refResult.value).toBeNull();
  });
});
