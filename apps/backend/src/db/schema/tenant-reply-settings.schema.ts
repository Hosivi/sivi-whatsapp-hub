/**
 * tenant-reply-settings.schema.ts — Drizzle schema for the tenant_reply_settings table.
 *
 * Per-tenant overrides for the fixed replies (greeting, hours, handoff) the Hub sends
 * until SiviHub's agent takes over (E4). Created by 0010_fixed_replies.sql.
 *
 * Column notes:
 * - At most one live row per tenant (partial unique index on tenant_id WHERE deleted_at IS NULL).
 * - No row at all → the default texts in code apply.
 * - business_name: the {negocio} placeholder value. NULL → the greeting without a name.
 * - hours_text: the {horario} placeholder value. NULL → the hours reply falls back to handoff.
 * - greeting_text / handoff_text: optional override templates ({negocio}, {horario}).
 * - enabled: false → no fixed replies at all for the tenant.
 * - deleted_at: soft-delete sentinel; NULL = active.
 */

import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const tenantReplySettingsTable = pgTable('tenant_reply_settings', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  businessName: text('business_name'),
  greetingText: text('greeting_text'),
  hoursText: text('hours_text'),
  handoffText: text('handoff_text'),
  enabled: boolean('enabled').default(true).notNull(),
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

export type TenantReplySettings = {
  readonly businessName: string | null;
  readonly greetingText: string | null;
  readonly hoursText: string | null;
  readonly handoffText: string | null;
  readonly enabled: boolean;
};

export const mapRowToTenantReplySettings = (
  row: typeof tenantReplySettingsTable.$inferSelect,
): TenantReplySettings => ({
  businessName: row.businessName ?? null,
  greetingText: row.greetingText ?? null,
  hoursText: row.hoursText ?? null,
  handoffText: row.handoffText ?? null,
  enabled: row.enabled,
});
