/**
 * sivihub-outbox-signature.ts — signSivihubEvent, the Hub side of the Hub → SiviHub
 * webhook signature (ADR-0048 corte 1, spec "Firma").
 *
 * MUST stay byte-identical to SiviHub's `verifyHubWebhookSignature` (the receiver's
 * executable truth, per the task contract):
 *   X-Sivi-Signature = "v1=" + hex(HMAC-SHA256(secret, "<timestamp>.<raw body>"))
 *
 * `secretHex` is the DECRYPTED channel secret (32 bytes, hex) — decrypt happens in
 * the drain immediately before signing, and the plaintext is NEVER logged.
 */

import { createHmac } from 'node:crypto';

const SIGNATURE_PREFIX = 'v1=';

export function signSivihubEvent(
  secretHex: string,
  rawBody: string,
  timestampSeconds: number,
): string {
  const secretBytes = Buffer.from(secretHex, 'hex');
  const hex = createHmac('sha256', secretBytes)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}
