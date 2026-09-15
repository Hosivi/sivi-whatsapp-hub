/**
 * sivihub-outbox.repository.ts — enqueueSivihubEvent (ADR-0048 corte 1,
 * walking skeleton B2).
 *
 * Called INSIDE the same withTenant tx as the whatsapp_messages write it
 * describes — the inbound insert in whatsapp.service.ts and the outbound insert
 * in whatsapp-send.service.ts (spec item 3: "outbox transaccional"). The caller
 * is responsible for calling this ONLY when the message row was actually
 * inserted (not a duplicate wamid) — this function itself only enforces
 * "no active link → nothing is written" (business rule 3).
 *
 * The payload shape is byte-for-byte the Hub → SiviHub contract envelope
 * (slice-04-ventas-redes-corte-1-hub.md, "El contrato Hub → SiviHub"). It is
 * built ONCE here and never mutated — every delivery attempt in the drain (B3)
 * re-signs these SAME bytes with only a fresh timestamp.
 */

import { sql as rawSql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { findActiveLink } from './sivihub-links.repository.js';

export type SivihubOutboxEventType = 'message.received' | 'message.sent';

export type SivihubOutboxEventInput = {
  readonly type: SivihubOutboxEventType;
  /** = the contract's provider_message_id (wamid) — also the outbox's event_id. */
  readonly providerMessageId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly author: 'contact' | 'agent' | 'ai';
  readonly contactExternalId: string;
  readonly contactName: string | null;
  readonly body: string | null;
  readonly mediaRef: unknown | null;
  /** The STORED received_at column value — never a fresh clock read (spec item 4). */
  readonly sentAt: Date;
};

/**
 * Enqueues one Hub → SiviHub event for the tenant's active link. A no-op — writes
 * NOTHING — when the tenant has no active link (business rule 3). Re-enqueuing the
 * same providerMessageId for the same link is a no-op too, via the outbox's own
 * UNIQUE (link_id, event_id) guard (migration 0007).
 */
export async function enqueueSivihubEvent(
  tx: PostgresJsDatabase,
  tenantId: string,
  input: SivihubOutboxEventInput,
): Promise<void> {
  const link = await findActiveLink(tx, tenantId);
  if (link === null) {
    return;
  }

  const payload = {
    id: input.providerMessageId,
    type: input.type,
    occurred_at: new Date().toISOString(),
    data: {
      provider_message_id: input.providerMessageId,
      direction: input.direction,
      author: input.author,
      contact: { external_id: input.contactExternalId, name: input.contactName },
      body: input.body,
      media_ref: input.mediaRef,
      sent_at: input.sentAt.toISOString(),
    },
  };

  await tx.execute(rawSql`
    INSERT INTO sivihub_event_outbox
      (tenant_id, link_id, event_id, type, payload, status, attempts, next_attempt_at)
    VALUES
      (${tenantId}::uuid, ${link.id}::uuid, ${input.providerMessageId}, ${input.type},
       ${JSON.stringify(payload)}::jsonb, 'pending', 0, now())
    ON CONFLICT (link_id, event_id) DO NOTHING
  `);
}
