/**
 * whatsapp-messages.repository.ts — Read-only repository for whatsapp_messages.
 *
 * Key invariants (mirrors contacts.repository.ts pattern):
 * - ALL database operations run inside withTenant(tenantId, ...) — RLS handles tenant scoping.
 * - NO WHERE tenant_id anywhere — RLS via withTenant is the sole enforcement.
 * - NO raw db/sql handle — receives only TenantRunner.
 * - adminSql never appears here.
 *
 * listMessages() query:
 *   SELECT ... FROM whatsapp_messages
 *   LEFT JOIN contacts ON whatsapp_messages.contact_id = contacts.id
 *   ORDER BY received_at DESC
 *   LIMIT 50
 * then, on the same tx, the live 'sent' ai_reply_usage rows of the outbound wamids
 * (author 'ai' + usage); skipped when migration 0009 is not applied yet.
 *
 * The RLS policy on whatsapp_messages already scopes to the current tenant — no
 * explicit WHERE tenant_id is added.
 */

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { findSentUsageByOutboundWamids } from '../ai/ai-reply-usage.repository.js';
import type { AiReplyUsageSummary } from '../ai/ai-reply-usage.repository.js';
import type { LlmMessage } from '../ai/llm-types.js';
import type { TenantRunner } from '../db/client.js';
import { contactsTable } from '../db/schema/contacts.schema.js';
import { whatsappMessagesTable } from '../db/schema/whatsapp-messages.schema.js';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * Who authored a message: the customer (inbound), the AI (outbound with a live
 * 'sent' ai_reply_usage row for its wamid) or a human operator (any other outbound).
 */
export type MessageAuthor = 'customer' | 'ai' | 'operator';

export type MessageDTO = {
  readonly wamid: string;
  /**
   * full_name of the conversation's CONTACT (the customer) for both directions —
   * for outbound rows this is the recipient, not the author; null if not available.
   */
  readonly name: string | null;
  /** The contact's phone (sender for inbound, recipient for outbound). */
  readonly phone: string;
  /** text body when message_type = 'text'; null otherwise */
  readonly text: string | null;
  readonly type: string;
  /** ISO 8601 UTC timestamp string */
  readonly receivedAt: string;
  /** 'inbound' | 'outbound' — mirrors the whatsapp_messages.direction column */
  readonly direction: string;
  readonly author: MessageAuthor;
  /** AI usage of the reply when author = 'ai'; null otherwise. */
  readonly ai: AiReplyUsageSummary | null;
};

// ---------------------------------------------------------------------------
// listMessages
// ---------------------------------------------------------------------------

/**
 * Returns the conversation history for a contact as LlmMessage[].
 *
 * Query strategy:
 * - SELECT only inbound messages (direction = 'inbound') with non-null text_body.
 * - Order by received_at DESC, LIMIT to the most recent `limit` rows.
 * - Reverse the slice to chronological order (oldest first) in JS.
 * - Map direction='inbound' → role 'user'.
 * - Outbound messages are excluded — the AI will not "remember" its own past replies
 *   in this slice (runAiReply Lote B will extend this for multi-turn context).
 *
 * RLS invariants:
 * - NO WHERE tenant_id — withTenant sets the GUC; RLS policy enforces isolation.
 * - NO adminSql — only the TenantRunner is used.
 *
 * @param withTenant - TenantRunner from the DbClient
 * @param tenantId   - UUID of the tenant (used only to set the RLS GUC)
 * @param contactId  - UUID of the contact whose history to fetch
 * @param limit      - Maximum number of messages to return (default 10)
 */
export async function getConversationHistory(
  withTenant: TenantRunner,
  tenantId: string,
  contactId: string,
  limit = 10,
): Promise<LlmMessage[]> {
  return withTenant(tenantId, async (tx) => {
    // Fetch the most recent `limit` inbound messages with non-null text (DESC)
    const rows = await tx
      .select({
        textBody: whatsappMessagesTable.textBody,
        receivedAt: whatsappMessagesTable.receivedAt,
      })
      .from(whatsappMessagesTable)
      .where(
        and(
          eq(whatsappMessagesTable.contactId, contactId),
          eq(whatsappMessagesTable.direction, 'inbound'),
          isNotNull(whatsappMessagesTable.textBody),
        ),
      )
      .orderBy(desc(whatsappMessagesTable.receivedAt))
      .limit(limit);

    // Reverse to chronological order (oldest first) and map to LlmMessage
    return rows
      .reverse()
      .map((row): LlmMessage => ({ role: 'user', content: row.textBody as string }));
  });
}

// ---------------------------------------------------------------------------
// listMessages
// ---------------------------------------------------------------------------

/**
 * Lists the 50 most recent messages for the given tenant (received_at DESC).
 * RLS on whatsapp_messages ensures only rows for the current tenant are returned.
 * No explicit WHERE tenant_id — withTenant sets the GUC, RLS policy enforces it.
 *
 * @param withTenant - TenantRunner from the DbClient
 * @param tenantId   - UUID of the tenant to query under
 */
export async function listMessages(
  withTenant: TenantRunner,
  tenantId: string,
): Promise<MessageDTO[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        wamid: whatsappMessagesTable.wamid,
        name: contactsTable.fullName,
        phone: whatsappMessagesTable.fromPhoneE164,
        text: whatsappMessagesTable.textBody,
        type: whatsappMessagesTable.messageType,
        receivedAt: whatsappMessagesTable.receivedAt,
        direction: whatsappMessagesTable.direction,
      })
      .from(whatsappMessagesTable)
      .leftJoin(contactsTable, eq(whatsappMessagesTable.contactId, contactsTable.id))
      .orderBy(desc(whatsappMessagesTable.receivedAt))
      .limit(50);

    // Same tenant-scoped tx: RLS on ai_reply_usage hides other tenants' rows.
    const usageByWamid = await findSentUsageByOutboundWamids(
      tx,
      rows.filter((row) => row.direction === 'outbound').map((row) => row.wamid),
    );

    return rows.map((row): MessageDTO => {
      const ai = row.direction === 'outbound' ? (usageByWamid.get(row.wamid) ?? null) : null;
      return {
        wamid: row.wamid,
        name: row.name ?? null,
        phone: row.phone,
        text: row.text ?? null,
        type: row.type,
        receivedAt: row.receivedAt.toISOString(),
        direction: row.direction,
        author: authorOf(row.direction, ai !== null),
        ai,
      };
    });
  });
}

const authorOf = (direction: string, hasAiUsage: boolean): MessageAuthor => {
  if (direction !== 'outbound') return 'customer';
  return hasAiUsage ? 'ai' : 'operator';
};
