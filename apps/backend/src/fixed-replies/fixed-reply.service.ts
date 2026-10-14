/**
 * fixed-reply.service.ts — Sends the fixed reply (greeting, hours, handoff) to a new inbound text.
 *
 * Runs while AI_REPLY_ENABLED is off (the default until SiviHub's agent takes over in E4).
 * The webhook route calls runFixedReply fire-and-forget, only for a NEW inbound text
 * (never for a re-delivered wamid).
 *
 * Steps:
 * 1. getReplySettings → enabled = false → skip (DISABLED).
 * 2. One query over the contact's inbound messages: is the 24 h service window open, and
 *    did the contact send another text in the last 24 h (excluding this message)?
 *    Window closed → skip (WINDOW_CLOSED): Meta rejects free-form text outside it.
 * 3. selectFixedReply → null → skip (NO_MATCH).
 * 4. renderFixedReply → sendWhatsappText (sends through Meta and stores the outbound message).
 *
 * Exactly one log line per run: fixed_reply_sent kind=<kind>,
 * fixed_reply_skipped reason=<DISABLED|WINDOW_CLOSED|NO_MATCH> or
 * fixed_reply_failed reason=<SEND_FAILED|DB_ERROR>.
 *
 * Never throws: every outcome is a Result; unexpected exceptions are caught at the boundary.
 * RLS: every query runs inside withTenant — no WHERE tenant_id.
 */

import { sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import type { TenantRunner } from '../db/client.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import { sendWhatsappText } from '../whatsapp-send/whatsapp-send.service.js';
import { type FixedReplyKind, renderFixedReply, selectFixedReply } from './fixed-reply.js';
import { getReplySettings } from './reply-settings.repository.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FixedReplyInput = {
  readonly contactId: string;
  readonly fromPhoneE164: string;
  readonly text: string;
  /** wamid of the inbound message being answered (excluded from the 24 h history). */
  readonly wamid: string;
};

export type FixedReplyOk = {
  readonly kind: FixedReplyKind;
  readonly wamid: string;
};

export type FixedReplyError =
  | { readonly code: 'DISABLED' }
  | { readonly code: 'WINDOW_CLOSED' }
  | { readonly code: 'NO_MATCH' }
  | { readonly code: 'SEND_FAILED'; readonly cause?: unknown }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };

// ---------------------------------------------------------------------------
// 24 h history
// ---------------------------------------------------------------------------

type InboundWindow = {
  /** The contact wrote in the last 24 h (WhatsApp service window). */
  readonly windowOpen: boolean;
  /** No other inbound text from the contact in the last 24 h. */
  readonly isFirstInboundInWindow: boolean;
};

/**
 * Reads the contact's inbound history in one query, using DB server time (NOW()) like
 * isWithin24hServiceWindow in ai-reply.service.ts. The message being answered is excluded
 * from the "another text" check so it never counts as its own predecessor.
 */
async function getInboundWindow(
  withTenant: TenantRunner,
  tenantId: string,
  contactId: string,
  currentWamid: string,
): Promise<InboundWindow> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute(
      sql`
        SELECT
          COALESCE(MAX(received_at) > NOW() - INTERVAL '24 hours', false) AS window_open,
          COALESCE(
            MAX(received_at) FILTER (WHERE wamid <> ${currentWamid} AND message_type = 'text')
              > NOW() - INTERVAL '24 hours',
            false
          ) AS has_other_text
        FROM whatsapp_messages
        WHERE contact_id = ${contactId}::uuid
          AND direction = 'inbound'
      `,
    );

    const row = (rows as unknown as Array<{ window_open: boolean; has_other_text: boolean }>)[0];
    return {
      windowOpen: row?.window_open === true,
      isFirstInboundInWindow: row?.has_other_text !== true,
    };
  });
}

// ---------------------------------------------------------------------------
// runFixedReply
// ---------------------------------------------------------------------------

/**
 * Answers a new inbound text with a fixed reply, or stays silent.
 *
 * @param deps     - AppDeps (db, meta, logger; the LLM is never used here).
 * @param tenantId - UUID of the tenant that received the message.
 * @param input    - { contactId, fromPhoneE164, text, wamid } of the inbound message.
 */
export async function runFixedReply(
  deps: AppDeps,
  tenantId: string,
  input: FixedReplyInput,
): Promise<Result<FixedReplyOk, FixedReplyError>> {
  const { contactId, fromPhoneE164, text, wamid } = input;
  const context = { tenantId, contactId, inboundWamid: wamid };

  try {
    const settingsResult = await getReplySettings(deps.db.withTenant, tenantId);
    if (!settingsResult.ok) {
      deps.logger.error(
        { ...context, error: settingsResult.error },
        'fixed_reply_failed reason=DB_ERROR',
      );
      return err({ code: 'DB_ERROR', cause: settingsResult.error } as const);
    }
    const settings = settingsResult.value;

    if (settings !== null && !settings.enabled) {
      deps.logger.info(context, 'fixed_reply_skipped reason=DISABLED');
      return err({ code: 'DISABLED' } as const);
    }

    const history = await getInboundWindow(deps.db.withTenant, tenantId, contactId, wamid);
    if (!history.windowOpen) {
      deps.logger.info(context, 'fixed_reply_skipped reason=WINDOW_CLOSED');
      return err({ code: 'WINDOW_CLOSED' } as const);
    }

    const kind = selectFixedReply({ text, isFirstInboundInWindow: history.isFirstInboundInWindow });
    if (kind === null) {
      deps.logger.info(context, 'fixed_reply_skipped reason=NO_MATCH');
      return err({ code: 'NO_MATCH' } as const);
    }

    const sendResult = await sendWhatsappText(deps, tenantId, {
      to: fromPhoneE164,
      text: renderFixedReply(kind, settings ?? {}),
    });
    if (!sendResult.ok) {
      deps.logger.error(
        { ...context, kind, error: sendResult.error },
        'fixed_reply_failed reason=SEND_FAILED',
      );
      return err({ code: 'SEND_FAILED', cause: sendResult.error } as const);
    }

    deps.logger.info(
      { ...context, kind, wamid: sendResult.value.wamid },
      `fixed_reply_sent kind=${kind}`,
    );
    return ok({ kind, wamid: sendResult.value.wamid });
  } catch (cause) {
    // Last-resort catch for unexpected exceptions (infrastructure failures, etc.).
    deps.logger.error({ ...context, cause }, 'fixed_reply_failed reason=DB_ERROR');
    return err({ code: 'DB_ERROR', cause } as const);
  }
}
