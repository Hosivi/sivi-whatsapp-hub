/**
 * tenant-payment-config.schema.ts — Drizzle schema for tenant_payment_config table.
 *
 * Stores per-tenant payment gateway configuration. At most one active row per
 * (tenant_id, provider) is allowed (partial unique index on deleted_at IS NULL).
 *
 * Column notes:
 * - provider: gateway identifier (currently 'culqi'; extend as new gateways ship).
 * - configured: boolean flag; false = gateway is registered but not yet fully set up.
 *   The use case guards on configured=true before calling the adapter.
 * - public_key: non-secret gateway public key for client-side tokenization.
 *   The private/secret key is NEVER stored here (will live in encrypted creds, later slice).
 * - deleted_at: soft-delete sentinel; NULL = active.
 *
 * Mirrors tenant-ai-config.schema.ts exactly.
 */

import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const tenantPaymentConfigTable = pgTable('tenant_payment_config', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  /** Payment gateway identifier. Currently only 'culqi'. */
  provider: text('provider').notNull(),
  /** True when the gateway has been fully configured for live payments. */
  configured: boolean('configured').default(false).notNull(),
  /** Non-secret public key for client-side tokenization (nullable until configured). */
  publicKey: text('public_key'),
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

export type TenantPaymentConfig = {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly configured: boolean;
  readonly publicKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
};

export const mapRowToTenantPaymentConfig = (
  row: typeof tenantPaymentConfigTable.$inferSelect,
): TenantPaymentConfig => ({
  id: row.id,
  tenantId: row.tenantId,
  provider: row.provider,
  configured: row.configured,
  publicKey: row.publicKey ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt ?? null,
});
