/**
 * whatsapp-accounts.schema.ts — Drizzle schema for the whatsapp_accounts table.
 *
 * Stores the per-tenant WhatsApp business phone number configuration.
 * Credentials (WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN) are GLOBAL env vars —
 * no per-row secret columns exist here (see design ADR: Credential model = GLOBAL).
 *
 * Column notes:
 * - phone_number_id: Meta's internal phone number identifier (not the E.164 number).
 * - display_phone_number: the human-readable E.164 number (e.g. +51987654321).
 * - waba_id: WhatsApp Business Account ID.
 * - is_active: soft-toggle; kept for forward-compat without soft-delete.
 * - deleted_at: soft-delete sentinel; NULL = active.
 * - Partial UNIQUE index on phone_number_id WHERE deleted_at IS NULL (in migration SQL).
 */

import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const whatsappAccountsTable = pgTable('whatsapp_accounts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  phoneNumberId: text('phone_number_id').notNull(),
  displayPhoneNumber: text('display_phone_number').notNull(),
  wabaId: text('waba_id').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
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

export type WhatsappAccount = {
  readonly id: string;
  readonly tenantId: string;
  readonly phoneNumberId: string;
  readonly displayPhoneNumber: string;
  readonly wabaId: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
};

export const mapRowToWhatsappAccount = (
  row: typeof whatsappAccountsTable.$inferSelect,
): WhatsappAccount => ({
  id: row.id,
  tenantId: row.tenantId,
  phoneNumberId: row.phoneNumberId,
  displayPhoneNumber: row.displayPhoneNumber,
  wabaId: row.wabaId,
  isActive: row.isActive,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt ?? null,
});
