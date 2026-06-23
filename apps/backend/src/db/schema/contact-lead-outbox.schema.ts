/**
 * contact-lead-outbox.schema.ts — Drizzle schema for the contact_lead_outbox table.
 *
 * This table is the transactional outbox for the ContactLead routing slice.
 * Rows are written atomically with the contacts.routed_at update (same tx).
 * A future worker drain process reads and processes pending rows.
 *
 * No FK to contacts by design (ADR-6): the outbox record must outlive its source
 * contact row. contact_id is a plain uuid reference, not a constraint.
 */

import type { ContactLead } from '@sivihub/contracts';
import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const contactLeadOutboxTable = pgTable('contact_lead_outbox', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  payload: jsonb('payload').$type<ContactLead>().notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});
