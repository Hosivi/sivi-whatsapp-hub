/**
 * sivihub-links.schema.ts — Drizzle schema for the sivihub_links table
 * (ADR-0048 corte 1, walking skeleton B1).
 *
 * One row per tenant's active link to a SiviHub events receiver. `secret_encrypted`
 * is ALWAYS the versioned cipher output from sivihub-link-secret-cipher.ts — never
 * plaintext. At most one `status = 'active'` row per tenant, enforced by the partial
 * unique index in migration 0006 (see sivihub-links.repository.ts for the upsert).
 */

import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const sivihubLinksTable = pgTable('sivihub_links', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  eventsUrl: text('events_url').notNull(),
  secretEncrypted: text('secret_encrypted').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export type SivihubLink = {
  readonly id: string;
  readonly tenantId: string;
  readonly eventsUrl: string;
  readonly secretEncrypted: string;
  readonly status: 'active' | 'revoked';
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export const mapRowToSivihubLink = (row: typeof sivihubLinksTable.$inferSelect): SivihubLink => ({
  id: row.id,
  tenantId: row.tenantId,
  eventsUrl: row.eventsUrl,
  secretEncrypted: row.secretEncrypted,
  status: row.status as SivihubLink['status'],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
