/**
 * payments.repository.ts — PaymentsRepository factory.
 *
 * Key invariants (mirrors contacts.repository.ts):
 * - ALL database operations run inside withTenant(tenantId, ...) — no query ever
 *   reaches Postgres outside a tenant-pinned transaction.
 * - NO WHERE tenant_id anywhere — RLS handles tenant scoping entirely.
 * - Domain logic returns Result<T,E> — NEVER throws.
 *
 * markPaid() design:
 *   UPDATE payments SET status='paid', paid_at=now() WHERE id=? AND status='pending' RETURNING *
 *   Returns { rowCount: 1 } on first call (pending→paid).
 *   Returns { rowCount: 0 } on subsequent calls (already paid — idempotent, no-op).
 *   The webhook service gates 'payment.paid' emission on rowCount > 0 to prevent re-emit.
 */

import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantRunner } from '../db/client.js';
import { mapRowToPayment, paymentsTable } from '../db/schema/payments.schema.js';
import type { Payment } from '../db/schema/payments.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type PaymentError =
  | { readonly code: 'PAYMENT_NOT_FOUND' }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type CreatePaymentInput = {
  readonly externalId: string;
  readonly reference: string;
  readonly amount: number;
  readonly currency: string;
  readonly sourceEntityType?: string | null;
  readonly sourceEntityId?: string | null;
  readonly metadata: Record<string, unknown>;
  readonly rawGatewayResponse?: unknown;
};

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export type PaymentsRepository = {
  createRecord(input: CreatePaymentInput): Promise<Result<Payment, PaymentError>>;
  /** Transitions pending→paid. Returns { rowCount: 1 } on first call; 0 if already paid (idempotent). */
  markPaid(
    id: string,
    rawGatewayResponse?: unknown,
  ): Promise<Result<{ rowCount: number }, PaymentError>>;
  findById(id: string): Promise<Result<Payment | null, PaymentError>>;
  findByReference(reference: string): Promise<Result<Payment | null, PaymentError>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createPaymentsRepository = (
  withTenant: TenantRunner,
  tenantId: string,
): PaymentsRepository => {
  // ------------------------------------------------------------------
  // createRecord — insert a new payment row with status='pending'
  // ------------------------------------------------------------------
  const createRecord = async (
    input: CreatePaymentInput,
  ): Promise<Result<Payment, PaymentError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      try {
        const inserted = await tx
          .insert(paymentsTable)
          .values({
            tenantId,
            externalId: input.externalId,
            reference: input.reference,
            amount: input.amount,
            currency: input.currency,
            status: 'pending',
            sourceEntityType: input.sourceEntityType ?? null,
            sourceEntityId: input.sourceEntityId ?? null,
            metadata: input.metadata,
            rawGatewayResponse: input.rawGatewayResponse ?? null,
          })
          .returning();

        const row = inserted[0];
        if (!row) {
          return err({ code: 'DB_ERROR' });
        }
        return ok(mapRowToPayment(row));
      } catch (cause) {
        return err({ code: 'DB_ERROR', cause });
      }
    });
  };

  // ------------------------------------------------------------------
  // markPaid — idempotent pending→paid transition
  // ------------------------------------------------------------------
  const markPaid = async (
    id: string,
    rawGatewayResponse?: unknown,
  ): Promise<Result<{ rowCount: number }, PaymentError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      try {
        const updated = await tx
          .update(paymentsTable)
          .set({
            status: 'paid',
            paidAt: new Date(),
            ...(rawGatewayResponse !== undefined ? { rawGatewayResponse } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(paymentsTable.id, id), eq(paymentsTable.status, 'pending')))
          .returning();

        return ok({ rowCount: updated.length });
      } catch (cause) {
        return err({ code: 'DB_ERROR', cause });
      }
    });
  };

  // ------------------------------------------------------------------
  // findById — look up a single payment by PK (RLS-scoped)
  // ------------------------------------------------------------------
  const findById = async (id: string): Promise<Result<Payment | null, PaymentError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      try {
        const rows = await tx.select().from(paymentsTable).where(eq(paymentsTable.id, id)).limit(1);

        const row = rows[0];
        return ok(row ? mapRowToPayment(row) : null);
      } catch (cause) {
        return err({ code: 'DB_ERROR', cause });
      }
    });
  };

  // ------------------------------------------------------------------
  // findByReference — look up a payment by human reference label (RLS-scoped)
  // ------------------------------------------------------------------
  const findByReference = async (
    reference: string,
  ): Promise<Result<Payment | null, PaymentError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      try {
        const rows = await tx
          .select()
          .from(paymentsTable)
          .where(eq(paymentsTable.reference, reference))
          .limit(1);

        const row = rows[0];
        return ok(row ? mapRowToPayment(row) : null);
      } catch (cause) {
        return err({ code: 'DB_ERROR', cause });
      }
    });
  };

  return { createRecord, markPaid, findById, findByReference };
};
