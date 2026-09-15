/**
 * whatsapp-send.service.ts — sendWhatsappText service.
 *
 * Flow:
 * 1. Resolve the single active whatsapp_accounts row (RLS via withTenant — NO WHERE tenant_id).
 * 2. Guard NULL access_token → OUTBOUND_NOT_CONFIGURED.
 * 3. Call Meta OUTSIDE any open transaction (separate network call).
 * 4. On success: open a second short write transaction:
 *    - upsertContactTx to resolve or create the recipient contact
 *    - INSERT whatsapp_messages with direction='outbound'
 * 5. Return ok({ wamid, status }).
 *
 * Hard invariants:
 * - NEVER throws outside the infra boundary (all throws are caught → Result).
 * - NEVER logs accessToken.
 * - NO WHERE tenant_id — RLS scopes all reads/writes.
 * - Meta call is OUTSIDE any DB transaction.
 */

import { sql as rawSql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { upsertContactTx } from '../contacts/contacts.repository.js';
import { normalizePhoneE164 } from '../contacts/phone-e164.js';
import type { TenantRunner } from '../db/client.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import { enqueueSivihubEvent } from '../sivihub-link/sivihub-outbox.repository.js';
import { mapMetaError } from './whatsapp-send.errors.js';
import type { WhatsappSendError } from './whatsapp-send.errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SendInput = {
  readonly to: string;
  readonly text: string;
  /**
   * Who sent it — the manual /whatsapp-send route always passes 'agent'; the AI
   * auto-reply orchestrator (ai-reply.service.ts) always passes 'ai'. Both funnel
   * through this ONE service (spec: "el envío manual y la autorespuesta pasan por
   * el mismo sendWhatsappText"), and this is the field that tells them apart in
   * the sivihub_event_outbox payload's data.author.
   */
  readonly author: 'agent' | 'ai';
};

export type SendOk = {
  readonly wamid: string;
  readonly status: string;
};

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the single active account for the given tenant.
 * Uses raw SQL to SELECT only the columns needed (avoids schema drift risk).
 * LIMIT 2 to cheaply detect misconfiguration (>1 active account).
 *
 * - 0 rows → NO_ACTIVE_ACCOUNT (→ 404)
 * - >1 rows → MULTIPLE_ACTIVE_ACCOUNTS (misconfig → 422)
 * - 1 row + access_token IS NULL → OUTBOUND_NOT_CONFIGURED
 * - 1 row + access_token set → ok({ phoneNumberId, accessToken })
 */
export const resolveActiveAccount = async (
  withTenant: TenantRunner,
  tenantId: string,
): Promise<Result<{ phoneNumberId: string; accessToken: string }, WhatsappSendError>> => {
  const rows = await withTenant(tenantId, async (tx) => {
    const result = await tx.execute(
      rawSql`
        SELECT phone_number_id, access_token
        FROM whatsapp_accounts
        WHERE is_active = true AND deleted_at IS NULL
        LIMIT 2
      `,
    );
    return result as unknown as Array<{ phone_number_id: string; access_token: string | null }>;
  });

  if (rows.length === 0) {
    return err({ code: 'NO_ACTIVE_ACCOUNT' });
  }

  if (rows.length > 1) {
    return err({ code: 'MULTIPLE_ACTIVE_ACCOUNTS' });
  }

  // rows.length === 1 at this point; index access is safe.
  // biome-ignore lint/style/noNonNullAssertion: guarded by rows.length === 1 check above
  const row = rows[0]!;
  if (row.access_token === null || row.access_token === undefined) {
    return err({ code: 'OUTBOUND_NOT_CONFIGURED' });
  }

  return ok({ phoneNumberId: row.phone_number_id, accessToken: row.access_token });
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Sends a WhatsApp text message to the given phone number.
 *
 * Pure domain service — returns Result<SendOk, WhatsappSendError>, never throws.
 * All infrastructure throws are caught at the appropriate boundary.
 */
export const sendWhatsappText = async (
  deps: AppDeps,
  tenantId: string,
  input: SendInput,
): Promise<Result<SendOk, WhatsappSendError>> => {
  // 1) Resolve the single active account (TX#1 — short read tx).
  const accountResult = await resolveActiveAccount(deps.db.withTenant, tenantId);
  if (!accountResult.ok) return accountResult;
  const { phoneNumberId, accessToken } = accountResult.value;

  // 2) Normalize the recipient with the SAME Peru rule the inbound webhook /
  //    contact upsert use. A generic E.164 number that is not a valid Peru
  //    number is rejected BEFORE calling Meta — do NOT send and do NOT persist.
  const normalizedTo = normalizePhoneE164(input.to);
  if (!normalizedTo.ok) {
    return err({ code: 'INVALID_RECIPIENT' });
  }
  const recipientPhoneE164 = normalizedTo.value;

  // 3) Call Meta OUTSIDE any tx (network call — do NOT hold a Postgres connection open).
  const sendResult = await deps.meta.sendText({
    phoneNumberId,
    accessToken,
    to: recipientPhoneE164,
    text: input.text,
  });
  if (!sendResult.ok) return err(mapMetaError(sendResult.error));
  const { wamid, status } = sendResult.value;

  // 4) Persist the outbound row (TX#2 — atomic write: upsert contact + insert message).
  try {
    await deps.db.withTenant(tenantId, async (tx) => {
      const contact = await upsertContactTx(tx, tenantId, {
        phone: recipientPhoneE164,
        source: 'whatsapp',
      });
      if (!contact.ok) {
        throw new Error(`upsertContactTx failed: ${contact.error.code}`);
      }
      // Computed once in JS (not a bare `now()` in SQL) so the SAME instant is both
      // the persisted received_at AND the sivihub_event_outbox event's sent_at
      // (spec item 4: "sent_at del evento = la columna guardada").
      const sentAt = new Date();
      // RETURNING id distinguishes a genuine insert from a no-op on a duplicate
      // wamid — the enqueue below MUST fire only for the former.
      const insertResult = await tx.execute(rawSql`
        INSERT INTO whatsapp_messages
          (tenant_id, wamid, phone_number_id, contact_id, from_phone_e164,
           message_type, text_body, raw_payload, received_at, direction)
        VALUES
          (${tenantId}::uuid,
           ${wamid},
           ${phoneNumberId},
           ${contact.value.id}::uuid,
           ${recipientPhoneE164},
           'text',
           ${input.text},
           ${JSON.stringify({ wamid, status })}::jsonb,
           ${sentAt.toISOString()}::timestamptz,
           'outbound')
        ON CONFLICT (wamid) DO NOTHING
        RETURNING id
      `);
      const wasInserted = (insertResult as unknown as Array<{ id: string }>).length > 0;

      // SiviHub Link (ADR-0048 corte 1, B2): enqueue in the SAME transaction.
      if (wasInserted) {
        await enqueueSivihubEvent(tx, tenantId, {
          type: 'message.sent',
          providerMessageId: wamid,
          direction: 'outbound',
          author: input.author,
          contactExternalId: recipientPhoneE164,
          contactName: contact.value.fullName,
          body: input.text,
          mediaRef: null,
          sentAt,
        });
      }
    });
  } catch (cause) {
    // Send already happened — surface DB_ERROR; never roll back the send.
    return err({ code: 'DB_ERROR', cause });
  }

  return ok({ wamid, status });
};
