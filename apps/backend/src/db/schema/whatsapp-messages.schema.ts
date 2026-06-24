/**
 * whatsapp-messages.schema.ts — Drizzle schema for the whatsapp_messages table.
 *
 * Stores raw inbound WhatsApp messages. Each row is immutable after insert.
 *
 * Column notes:
 * - wamid: Meta's unique message ID; UNIQUE constraint prevents duplicate ingestion.
 * - phone_number_id: Meta's internal phone number identifier (links to whatsapp_accounts).
 * - contact_id: FK to contacts(id), NOT NULL. The contact upsert always runs before insert.
 * - from_phone_e164: sender's normalized E.164 phone number (+51XXXXXXXXX).
 * - message_type: e.g. 'text', 'image', 'audio', etc. (raw from Meta payload).
 * - text_body: text content when message_type = 'text'; null otherwise.
 * - raw_payload: full Meta message object as JSONB (for forward-compat / debugging).
 * - received_at: timestamp from the Meta payload (not the DB insert time).
 * - created_at: DB insert time.
 *
 * No direction column — this table stores inbound messages only (YAGNI for now).
 */

import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { contactsTable } from './contacts.schema.js';

export const whatsappMessagesTable = pgTable('whatsapp_messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  wamid: text('wamid').notNull(),
  phoneNumberId: text('phone_number_id').notNull(),
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contactsTable.id),
  fromPhoneE164: text('from_phone_e164').notNull(),
  messageType: text('message_type').notNull(),
  textBody: text('text_body'),
  rawPayload: jsonb('raw_payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

export type WhatsappMessage = {
  readonly id: string;
  readonly tenantId: string;
  readonly wamid: string;
  readonly phoneNumberId: string;
  readonly contactId: string;
  readonly fromPhoneE164: string;
  readonly messageType: string;
  readonly textBody: string | null;
  readonly rawPayload: unknown;
  readonly receivedAt: Date;
  readonly createdAt: Date;
};

export const mapRowToWhatsappMessage = (
  row: typeof whatsappMessagesTable.$inferSelect,
): WhatsappMessage => ({
  id: row.id,
  tenantId: row.tenantId,
  wamid: row.wamid,
  phoneNumberId: row.phoneNumberId,
  contactId: row.contactId,
  fromPhoneE164: row.fromPhoneE164,
  messageType: row.messageType,
  textBody: row.textBody ?? null,
  rawPayload: row.rawPayload,
  receivedAt: row.receivedAt,
  createdAt: row.createdAt,
});
