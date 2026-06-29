/**
 * payments.schema.ts — Drizzle schema for the payments table.
 *
 * Stores a payment record per link created. Status follows the state machine:
 *   pending → paid | failed | expired (append-only; no backwards transitions).
 *
 * Column notes:
 * - amount: integer in minor units (e.g. centavos for PEN, cents for USD).
 * - external_id: gateway-assigned reference, unique across all payments.
 * - reference: free-text human label (order ref, conversation id, etc.).
 * - source_entity_type / source_entity_id: optional link to a domain entity
 *   (e.g. a contact or appointment). Both are nullable.
 * - metadata: jsonb blob; MUST include { tenantId, paymentId } embedded by the
 *   use case so the Culqi webhook can resolve tenant without a cross-tenant read.
 * - raw_gateway_response: audit trail of the raw gateway API response.
 * - paid_at: set on the pending→paid transition.
 * - deleted_at: soft-delete sentinel; NULL = active.
 */

import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const paymentsTable = pgTable('payments', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  /** Amount in minor units (centavos, cents, etc.). */
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  /** State machine: pending → paid | failed | expired. */
  status: text('status').notNull().default('pending'),
  /** Unique gateway reference (e.g. Culqi charge ID). */
  externalId: text('external_id').unique().notNull(),
  /** Human-readable payment reference label. */
  reference: text('reference').notNull(),
  /** Optional source entity type (e.g. 'contact', 'appointment'). */
  sourceEntityType: text('source_entity_type'),
  /** Optional source entity UUID. */
  sourceEntityId: uuid('source_entity_id'),
  /** Embedded metadata; must include tenantId + paymentId for webhook resolution. */
  metadata: jsonb('metadata').notNull(),
  /** Raw gateway API response for audit. */
  rawGatewayResponse: jsonb('raw_gateway_response'),
  /** Timestamp of the pending→paid transition. NULL while pending/failed/expired. */
  paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

/** Payment status values. */
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired';

export type Payment = {
  readonly id: string;
  readonly tenantId: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly externalId: string;
  readonly reference: string;
  readonly sourceEntityType: string | null;
  readonly sourceEntityId: string | null;
  readonly metadata: unknown;
  readonly rawGatewayResponse: unknown;
  readonly paidAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
};

export const mapRowToPayment = (row: typeof paymentsTable.$inferSelect): Payment => ({
  id: row.id,
  tenantId: row.tenantId,
  amount: row.amount,
  currency: row.currency,
  status: row.status as PaymentStatus,
  externalId: row.externalId,
  reference: row.reference,
  sourceEntityType: row.sourceEntityType ?? null,
  sourceEntityId: row.sourceEntityId ?? null,
  metadata: row.metadata,
  rawGatewayResponse: row.rawGatewayResponse ?? null,
  paidAt: row.paidAt ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt ?? null,
});
