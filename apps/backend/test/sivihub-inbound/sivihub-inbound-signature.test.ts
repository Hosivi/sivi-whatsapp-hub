/**
 * sivihub-inbound-signature.test.ts — Unit tests for verifySivihubSignature.
 *
 * Pure Vitest — no DB, no Hono. Exercises the SiviHub → Hub signature scheme in
 * the verify direction (ADR-0048 corte 4, S1). The signed-string construction is
 * reused from signSivihubEvent (sivihub-outbox-signature.ts) rather than being
 * reimplemented here — these tests prove the two stay byte-identical.
 *
 * STRICT TDD MODE — written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import { verifySivihubSignature } from '../../src/sivihub-inbound/sivihub-inbound-signature.js';
import { signSivihubEvent } from '../../src/sivihub-link/sivihub-outbox-signature.js';

const SECRET_HEX = 'a'.repeat(64);
const OTHER_SECRET_HEX = 'b'.repeat(64);
const RAW_BODY = JSON.stringify({ to: '+51987654321', text: 'Hola' });
const NOW_SECONDS = 1_700_000_000;

function sign(secretHex: string, rawBody: string, timestampSeconds: number): string {
  return signSivihubEvent(secretHex, rawBody, timestampSeconds);
}

describe('verifySivihubSignature', () => {
  it('(a) valid signature + fresh timestamp → true', () => {
    const signature = sign(SECRET_HEX, RAW_BODY, NOW_SECONDS);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(NOW_SECONDS),
      signatureHeader: signature,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(true);
  });

  it('(b) signature computed with a DIFFERENT secret → false', () => {
    const signature = sign(OTHER_SECRET_HEX, RAW_BODY, NOW_SECONDS);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(NOW_SECONDS),
      signatureHeader: signature,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(c) tampered body after signing → false', () => {
    const signature = sign(SECRET_HEX, RAW_BODY, NOW_SECONDS);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: `${RAW_BODY}x`,
      timestampHeader: String(NOW_SECONDS),
      signatureHeader: signature,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(d) timestamp 301s in the past → false (outside ±300s window)', () => {
    const pastTimestamp = NOW_SECONDS - 301;
    const signature = sign(SECRET_HEX, RAW_BODY, pastTimestamp);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(pastTimestamp),
      signatureHeader: signature,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(e) timestamp 301s in the future → false (outside ±300s window)', () => {
    const futureTimestamp = NOW_SECONDS + 301;
    const signature = sign(SECRET_HEX, RAW_BODY, futureTimestamp);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(futureTimestamp),
      signatureHeader: signature,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(f) timestamp exactly 300s in the past → true (inclusive boundary)', () => {
    const boundaryTimestamp = NOW_SECONDS - 300;
    const signature = sign(SECRET_HEX, RAW_BODY, boundaryTimestamp);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(boundaryTimestamp),
      signatureHeader: signature,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(true);
  });

  it('(g) missing signature header → false', () => {
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(NOW_SECONDS),
      signatureHeader: undefined,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(h) missing timestamp header → false', () => {
    const signature = sign(SECRET_HEX, RAW_BODY, NOW_SECONDS);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: undefined,
      signatureHeader: signature,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(i) signature header missing the "v1=" prefix → false', () => {
    const signature = sign(SECRET_HEX, RAW_BODY, NOW_SECONDS);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(NOW_SECONDS),
      signatureHeader: signature.replace('v1=', ''),
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(j) non-numeric timestamp header → false', () => {
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: 'not-a-number',
      signatureHeader: 'v1=deadbeef',
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(k) signature hex shorter than expected (length mismatch) → false, never throws', () => {
    expect(() =>
      verifySivihubSignature({
        secretHex: SECRET_HEX,
        rawBody: RAW_BODY,
        timestampHeader: String(NOW_SECONDS),
        signatureHeader: 'v1=ab',
        nowSeconds: NOW_SECONDS,
      }),
    ).not.toThrow();
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(NOW_SECONDS),
      signatureHeader: 'v1=ab',
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(false);
  });

  it('(l) matches signSivihubEvent byte-for-byte (reuses the same signed-string shape)', () => {
    // The whole point of reusing signSivihubEvent internally: a signature this
    // module computes for verification must be identical to one the outbox
    // signer produces for the SAME inputs.
    const timestampSeconds = NOW_SECONDS;
    const expectedSignature = signSivihubEvent(SECRET_HEX, RAW_BODY, timestampSeconds);
    const result = verifySivihubSignature({
      secretHex: SECRET_HEX,
      rawBody: RAW_BODY,
      timestampHeader: String(timestampSeconds),
      signatureHeader: expectedSignature,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toBe(true);
  });
});
