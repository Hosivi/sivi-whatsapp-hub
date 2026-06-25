/**
 * sign-payload.ts — Signing proxy payload builder.
 *
 * Builds a Meta-shaped inbound message payload and computes its HMAC-SHA256
 * signature using the same algorithm as resolveSignature in whatsapp.service.ts.
 *
 * LOAD-BEARING: the returned `payload` is the CANONICAL SERIALIZED STRING the HMAC
 * was computed over. The caller (browser or test) MUST POST this exact string as the
 * request body — it MUST NOT re-serialize the payload object. Re-serializing would
 * produce a different byte sequence and invalidate the signature.
 *
 * SECURITY: WHATSAPP_APP_SECRET (the `appSecret` parameter) MUST NOT appear in the
 * returned object and MUST NOT be logged.
 */

import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export type BuildSignedMetaPayloadInput = {
  readonly phone: string;
  readonly profileName?: string;
  readonly text: string;
  readonly phoneNumberId: string;
  readonly appSecret: string;
};

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export type BuildSignedMetaPayloadResult = {
  /** The canonical JSON string the HMAC was computed over. POST this verbatim. */
  readonly payload: string;
  /** "sha256=<64-hex-chars>" — byte-identical to what resolveSignature verifies. */
  readonly signatureHeader: string;
  /** Unique wamid generated server-side for this call. */
  readonly wamid: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a signed Meta-shaped inbound webhook payload for dev/testing purposes.
 *
 * Algorithm (byte-identical to resolveSignature in whatsapp.service.ts):
 *   HMAC = crypto.createHmac('sha256', appSecret).update(Buffer.from(rawBody)).digest('hex')
 *   signatureHeader = 'sha256=' + HMAC
 *
 * @param input - Phone, text, optional profile name, phoneNumberId, and the app secret.
 * @returns { payload (canonical string), signatureHeader, wamid }
 */
export function buildSignedMetaPayload(
  input: BuildSignedMetaPayloadInput,
): BuildSignedMetaPayloadResult {
  const { phone, profileName, text, phoneNumberId, appSecret } = input;

  // Generate a server-side unique wamid. Using crypto.randomUUID() ensures uniqueness
  // across calls and defeats ON CONFLICT (wamid) DO NOTHING idempotency on re-send.
  const wamid = `wamid.${crypto.randomUUID()}`;

  // Build the Meta-shaped object matching metaPayloadSchema.
  // Timestamp uses current Unix seconds (as Meta does).
  const timestamp = String(Math.floor(Date.now() / 1000));

  const metaObject = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'dev-entry-id',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: phone,
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  profile: {
                    name: profileName ?? 'Dev User',
                  },
                  wa_id: phone.replace(/^\+/, ''),
                },
              ],
              messages: [
                {
                  id: wamid,
                  from: phone.replace(/^\+/, ''),
                  timestamp,
                  type: 'text',
                  text: {
                    body: text,
                  },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };

  // Serialize ONCE to a canonical string. This is the exact byte sequence
  // the HMAC is computed over. The caller must POST this string verbatim.
  const rawBody = JSON.stringify(metaObject);

  // Compute HMAC — byte-identical to resolveSignature in whatsapp.service.ts:
  //   crypto.createHmac('sha256', appSecret).update(Buffer.from(rawBody)).digest('hex')
  const hmacHex = crypto.createHmac('sha256', appSecret).update(Buffer.from(rawBody)).digest('hex');

  const signatureHeader = `sha256=${hmacHex}`;

  return { payload: rawBody, signatureHeader, wamid };
}
