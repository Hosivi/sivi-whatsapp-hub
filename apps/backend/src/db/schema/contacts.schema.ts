/**
 * contacts.schema.ts — Drizzle schema for the contacts table.
 *
 * IMPORTANT — NUMERIC coercion: postgres.js/Drizzle return NUMERIC columns as
 * strings by default. The mapRowToContact() function MUST convert intent_confidence
 * to a JS number before returning the domain Contact type. See the row mapper below.
 *
 * Column notes:
 * - intent_confidence: NUMERIC(5,4) with CHECK (0 ≤ value ≤ 1); nullable.
 * - updated_at: app-set on every write (new Date()), NOT a DB trigger.
 * - deleted_at: soft-delete sentinel; NULL = active.
 * - tags: TEXT[] with default '{}'; never null.
 */

import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom NUMERIC(5,4) type — drizzle-kit emits the correct SQL column type
// but the JS-side value is kept as a string (Postgres driver behavior).
// The domain mapper converts it to number | null.
// ---------------------------------------------------------------------------

const numericPrecision = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'NUMERIC(5,4)';
  },
});

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const contactsTable = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
    tenantId: uuid('tenant_id').notNull(),
    phoneE164: text('phone_e164').notNull(),
    fullName: text('full_name'),
    source: text('source'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    intent: text('intent'),
    intentConfidence: numericPrecision('intent_confidence'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    routedAt: timestamp('routed_at', { withTimezone: true, mode: 'date' }), // nullable; NULL = not yet routed
  },
  (t) => [
    // Partial unique index: enforces uniqueness only on live (non-deleted) rows.
    // Soft-deleted rows are excluded so resurrect logic can INSERT a new row
    // without hitting the constraint.
    uniqueIndex('contacts_tenant_phone_uq')
      .on(t.tenantId, t.phoneE164)
      .where(sql`${t.deletedAt} IS NULL`),
    // Index to support tenant-scoped list queries ordered by created_at DESC.
    index('contacts_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Domain Contact type — camelCase; intentConfidence is number | null (not string).
// ---------------------------------------------------------------------------

export type Contact = {
  readonly id: string;
  readonly tenantId: string;
  readonly phoneE164: string;
  readonly fullName: string | null;
  readonly source: string | null;
  readonly tags: string[];
  readonly intent: string | null;
  readonly intentConfidence: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly routedAt: Date | null;
};

/**
 * Maps a raw Drizzle row from the contacts table to the domain Contact type.
 * Converts intent_confidence from string (Postgres driver) to number | null.
 */
export const mapRowToContact = (row: typeof contactsTable.$inferSelect): Contact => ({
  id: row.id,
  tenantId: row.tenantId,
  phoneE164: row.phoneE164,
  fullName: row.fullName ?? null,
  source: row.source ?? null,
  tags: row.tags ?? [],
  intent: row.intent ?? null,
  intentConfidence: row.intentConfidence == null ? null : Number(row.intentConfidence),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt ?? null,
  routedAt: row.routedAt ?? null,
});
