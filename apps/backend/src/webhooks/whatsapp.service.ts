/**
 * whatsapp.service.ts — WhatsApp inbound message ingestion service.
 *
 * Pure-ish service: given raw HTTP body + signature header + app deps,
 * verifies HMAC-SHA256, Zod-parses the Meta payload, resolves tenant,
 * normalizes phone, then runs ONE withTenant transaction:
 *   upsertContactTx(tx, ...) → INSERT whatsapp_messages ON CONFLICT (wamid) DO NOTHING.
 *
 * Returns Result<{ wamid, contactId }, WhatsappWebhookError>.
 * ALL error paths return err(...) — nothing throws out to the route handler.
 *
 * Error → HTTP mapping (ack-fast contract):
 *   Every WhatsappWebhookError variant → 200 OK (logged, never surfaced to Meta).
 */

import * as crypto from 'node:crypto';
import { sql as rawSql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { upsertContactTx } from '../contacts/contacts.repository.js';
import { normalizePhoneE164 } from '../contacts/phone-e164.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type { WhatsappWebhookError } from './whatsapp.errors.js';

// ---------------------------------------------------------------------------
// Meta inbound payload Zod schema
// ---------------------------------------------------------------------------

const metaMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z
    .object({
      body: z.string(),
    })
    .optional(),
});

const metaContactSchema = z.object({
  profile: z.object({
    name: z.string().optional(),
  }),
  wa_id: z.string().optional(),
});

const metaValueSchema = z.object({
  messaging_product: z.string().optional(),
  metadata: z.object({
    display_phone_number: z.string().optional(),
    phone_number_id: z.string(),
  }),
  contacts: z.array(metaContactSchema).optional(),
  messages: z.array(metaMessageSchema).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const metaChangeSchema = z.object({
  value: metaValueSchema,
  field: z.string().optional(),
});

export const metaPayloadSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        changes: z.array(metaChangeSchema).min(1),
      }),
    )
    .min(1),
});

export type MetaPayload = z.infer<typeof metaPayloadSchema>;

// ---------------------------------------------------------------------------
// resolveSignature — pure HMAC-SHA256 verification (never throws out)
//
// Strips the "sha256=" prefix, length-checks both buffers BEFORE calling
// crypto.timingSafeEqual (which throws on length mismatch), wraps everything
// in try/catch so no exception escapes the handler.
//
// Returns true  → signature is valid.
// Returns false → signature is invalid, absent, or length-guard fired.
// ---------------------------------------------------------------------------

export function resolveSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  try {
    if (!signatureHeader) {
      return false;
    }

    if (!signatureHeader.startsWith('sha256=')) {
      return false;
    }

    const hexFromHeader = signatureHeader.slice('sha256='.length);
    const expectedBuf = Buffer.from(hexFromHeader, 'hex');

    const computedHex = crypto
      .createHmac('sha256', appSecret)
      .update(Buffer.from(rawBody))
      .digest();
    const computedBuf = Buffer.from(computedHex);

    // Length-check BEFORE timingSafeEqual — it throws on length mismatch.
    if (expectedBuf.length !== computedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, computedBuf);
  } catch {
    // Safety net: should never reach here after the length-check, but ensures
    // no exception escapes the handler under any circumstances.
    return false;
  }
}

// ---------------------------------------------------------------------------
// handleInboundMessage — main ingestion service function
// ---------------------------------------------------------------------------

export const handleInboundMessage = async (
  deps: AppDeps,
  rawBody: ArrayBuffer,
  signatureHeader: string | undefined,
): Promise<
  Result<
    {
      wamid: string;
      contactId: string;
      tenantId: string;
      fromPhoneE164: string;
      text: string | null;
    },
    WhatsappWebhookError
  >
> => {
  // Step 1: HMAC signature verification (raw body, global APP_SECRET)
  const signatureOk = resolveSignature(rawBody, signatureHeader, deps.env.WHATSAPP_APP_SECRET);
  if (!signatureOk) {
    return err({ code: 'BAD_SIGNATURE' });
  }

  // Step 2: JSON parse + Zod validation
  // Note: INVALID_PAYLOAD is not a separate error code; design maps parse errors to NO_MESSAGES
  // (ack-fast, nothing to process). We use NO_MESSAGES for Zod-invalid payloads too.
  let payload: MetaPayload;
  try {
    const text = Buffer.from(rawBody).toString('utf-8');
    const parsed = JSON.parse(text) as unknown;
    const zodResult = metaPayloadSchema.safeParse(parsed);
    if (!zodResult.success) {
      return err({ code: 'NO_MESSAGES' });
    }
    payload = zodResult.data;
  } catch {
    // JSON.parse failed
    return err({ code: 'NO_MESSAGES' });
  }

  // Step 3: Extract value from first entry/change pair
  const firstEntry = payload.entry[0];
  const firstChange = firstEntry?.changes[0];
  const value = firstChange?.value;

  if (!value) {
    return err({ code: 'NO_MESSAGES' });
  }

  // Step 4: Status-only event → skip (no messages array or empty)
  const messages = value.messages;
  if (!messages || messages.length === 0) {
    return err({ code: 'NO_MESSAGES' });
  }

  const message = messages[0];
  if (!message) {
    return err({ code: 'NO_MESSAGES' });
  }

  // Step 5: Tenant resolution from phone_number_id
  const phoneNumberId = value.metadata.phone_number_id;
  const tenantResult = await deps.db.resolveTenant(phoneNumberId);
  if (!tenantResult.ok) {
    return err({ code: 'UNKNOWN_PHONE_NUMBER_ID' });
  }
  const tenantId = tenantResult.value;

  // Step 6: Normalize the sender's phone (wa_id / from field)
  const waId = message.from;
  const phoneResult = normalizePhoneE164(waId);
  if (!phoneResult.ok) {
    return err({ code: 'INVALID_PHONE' });
  }
  const fromPhoneE164 = phoneResult.value;

  // Step 7: Single withTenant transaction — upsertContact + insert message
  try {
    const result = await deps.db.withTenant(tenantId, async (tx) => {
      // 7a: Upsert or reuse contact
      const contactResult = await upsertContactTx(tx, tenantId, {
        phone: fromPhoneE164,
        source: 'whatsapp',
        fullName: firstEntry?.changes[0]?.value?.contacts?.[0]?.profile?.name ?? null,
      });

      if (!contactResult.ok) {
        // Throw inside tx → triggers rollback → outer catch → DB_ERROR
        throw new Error(`upsertContactTx failed: ${contactResult.error.code}`);
      }

      const contact = contactResult.value;

      // 7b: Insert message with ON CONFLICT (wamid) DO NOTHING (idempotency)
      const receivedAt = new Date(Number(message.timestamp) * 1000);
      const rawPayload = {
        id: message.id,
        from: message.from,
        timestamp: message.timestamp,
        type: message.type,
        ...(message.text ? { text: message.text } : {}),
      };

      await tx.execute(
        rawSql`
          INSERT INTO whatsapp_messages
            (tenant_id, wamid, phone_number_id, contact_id, from_phone_e164,
             message_type, text_body, raw_payload, received_at)
          VALUES
            (${tenantId}::uuid,
             ${message.id},
             ${phoneNumberId},
             ${contact.id}::uuid,
             ${fromPhoneE164},
             ${message.type},
             ${message.text?.body ?? null},
             ${JSON.stringify(rawPayload)}::jsonb,
             ${receivedAt.toISOString()}::timestamptz)
          ON CONFLICT (wamid) DO NOTHING
        `,
      );

      return { wamid: message.id, contactId: contact.id };
    });

    return ok({ ...result, tenantId, fromPhoneE164, text: message.text?.body ?? null });
  } catch (cause) {
    return err({ code: 'DB_ERROR', cause });
  }
};
