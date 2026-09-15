/**
 * sivihub-event-outbox.schema.ts — Drizzle schema for the sivihub_event_outbox table
 * (ADR-0048 corte 1, walking skeleton B2 + B3).
 *
 * One row per Hub-side domain event queued for delivery to a tenant's SiviHub events
 * receiver. `payload` is the exact JSON body the drain (B3) sends — built once at
 * enqueue time and never mutated, so every delivery attempt re-signs the SAME bytes
 * with only a fresh timestamp (spec: "sent_at del evento = la columna guardada").
 */

import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const sivihubEventOutboxTable = pgTable('sivihub_event_outbox', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  linkId: uuid('link_id').notNull(),
  eventId: text('event_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
});

export type SivihubEventOutboxStatus = 'pending' | 'delivered' | 'dead';

export type SivihubEventOutboxRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly linkId: string;
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly status: SivihubEventOutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
};
