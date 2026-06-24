/**
 * whatsapp.errors.ts — WhatsappWebhookError discriminated union.
 *
 * ALL variants map to HTTP 200 (ack-fast contract).
 * Nothing in the webhook module throws these — they are always wrapped in err().
 *
 * Codes:
 *   BAD_SIGNATURE         — X-Hub-Signature-256 absent or HMAC mismatch
 *   UNKNOWN_PHONE_NUMBER_ID — phone_number_id not found in whatsapp_accounts
 *   INVALID_PHONE          — wa_id failed normalizePhoneE164 (non-Peru number)
 *   NO_MESSAGES            — status-only event (no value.messages array)
 *   DB_ERROR               — unexpected database-layer error during upsert/insert
 */

export type WhatsappWebhookError =
  | { readonly code: 'BAD_SIGNATURE' }
  | { readonly code: 'UNKNOWN_PHONE_NUMBER_ID' }
  | { readonly code: 'INVALID_PHONE' }
  | { readonly code: 'NO_MESSAGES' }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };
