/**
 * sivihub-inbound-signature.ts — verifySivihubSignature, the Hub side of the
 * SiviHub → Hub authenticated reply signature (ADR-0048 corte 4, S1).
 *
 * This is the SAME scheme corte 1 already defined for the opposite direction
 * (signSivihubEvent, sivihub-outbox-signature.ts), now verified instead of
 * produced:
 *   X-Sivi-Signature = "v1=" + hex(HMAC-SHA256(secret, "<timestamp>.<raw body>"))
 *   X-Sivi-Timestamp  = seconds since epoch, must be within ±300s of "now"
 *
 * Reuses signSivihubEvent to compute the expected signature rather than
 * reimplementing the HMAC construction — the two MUST stay byte-identical.
 *
 * `secretHex` is the DECRYPTED channel secret — decrypt happens in the auth
 * middleware immediately before calling this, and the plaintext is NEVER logged.
 */

import { timingSafeEqual } from 'node:crypto';
import { signSivihubEvent } from '../sivihub-link/sivihub-outbox-signature.js';

export const SIVIHUB_LINK_ID_HEADER = 'X-Sivi-Link-Id';
export const SIVIHUB_TIMESTAMP_HEADER = 'X-Sivi-Timestamp';
export const SIVIHUB_SIGNATURE_HEADER = 'X-Sivi-Signature';

const SIGNATURE_PREFIX = 'v1=';
const TIMESTAMP_WINDOW_SECONDS = 300;

export type VerifySivihubSignatureInput = {
  /** The DECRYPTED channel secret (hex) — never the ciphertext. */
  readonly secretHex: string;
  readonly rawBody: string;
  readonly timestampHeader: string | undefined;
  readonly signatureHeader: string | undefined;
  /** Injected clock (seconds since epoch) — Math.floor(Date.now() / 1000) at the call site. */
  readonly nowSeconds: number;
};

/**
 * Verifies a SiviHub-originated request's HMAC-SHA256 signature and its
 * ±300s freshness window. NEVER throws — any malformed input (missing headers,
 * non-numeric timestamp, malformed hex, length mismatch) collapses to `false`,
 * exactly like resolveSignature (webhooks/whatsapp.service.ts) does for the
 * Meta-inbound direction.
 *
 * Length-checks both buffers BEFORE calling timingSafeEqual, which throws on a
 * length mismatch rather than returning false.
 */
export function verifySivihubSignature(input: VerifySivihubSignatureInput): boolean {
  try {
    const { secretHex, rawBody, timestampHeader, signatureHeader, nowSeconds } = input;

    if (!timestampHeader || !signatureHeader) {
      return false;
    }
    if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
      return false;
    }

    const timestampSeconds = Number(timestampHeader);
    if (!Number.isFinite(timestampSeconds)) {
      return false;
    }

    // ±300s replay window — checked against the SAME timestamp the signature covers.
    if (Math.abs(nowSeconds - timestampSeconds) > TIMESTAMP_WINDOW_SECONDS) {
      return false;
    }

    const expected = signSivihubEvent(secretHex, rawBody, timestampSeconds);
    const expectedBuf = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
    const actualBuf = Buffer.from(signatureHeader.slice(SIGNATURE_PREFIX.length), 'hex');

    // Length-check BEFORE timingSafeEqual — it throws on length mismatch.
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    // Safety net: should never reach here after the guards above, but ensures
    // no exception escapes the caller under any circumstances.
    return false;
  }
}
