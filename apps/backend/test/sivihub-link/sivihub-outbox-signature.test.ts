/**
 * sivihub-outbox-signature.test.ts — Unit tests for signSivihubEvent, the Hub-side
 * signer for the outbox drain (ADR-0048 corte 1, walking skeleton B3).
 *
 * MUST be byte-identical to SiviHub's own verifyHubWebhookSignature (the receiver's
 * executable truth): HMAC-SHA256(secretBytes, "<timestamp>.<raw body>"), hex-encoded,
 * prefixed "v1=". Independently recomputed here with node:crypto (not by importing
 * the signer's own internals) so the test can't rubber-stamp a wrong implementation.
 *
 * Pure Vitest — no DB. STRICT TDD MODE — written RED before implementation.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signSivihubEvent } from '../../src/sivihub-link/sivihub-outbox-signature.js';

const SECRET_HEX = 'a'.repeat(64);

function referenceSignature(secretHex: string, rawBody: string, timestampSeconds: number): string {
  const secretBytes = Buffer.from(secretHex, 'hex');
  const hex = createHmac('sha256', secretBytes)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest('hex');
  return `v1=${hex}`;
}

describe('signSivihubEvent', () => {
  it('matches an independently computed HMAC-SHA256("<timestamp>.<body>") signature', () => {
    const body = JSON.stringify({ id: 'wamid.1', type: 'message.received' });
    const timestamp = 1_800_000_000;
    const expected = referenceSignature(SECRET_HEX, body, timestamp);
    expect(signSivihubEvent(SECRET_HEX, body, timestamp)).toBe(expected);
  });

  it('is prefixed with "v1="', () => {
    const sig = signSivihubEvent(SECRET_HEX, '{}', 1_800_000_000);
    expect(sig.startsWith('v1=')).toBe(true);
  });

  it('produces a DIFFERENT signature for a different timestamp, same body', () => {
    const body = '{"a":1}';
    const sigA = signSivihubEvent(SECRET_HEX, body, 1_800_000_000);
    const sigB = signSivihubEvent(SECRET_HEX, body, 1_800_000_001);
    expect(sigA).not.toBe(sigB);
  });

  it('produces a DIFFERENT signature for a different body, same timestamp', () => {
    const timestamp = 1_800_000_000;
    const sigA = signSivihubEvent(SECRET_HEX, '{"a":1}', timestamp);
    const sigB = signSivihubEvent(SECRET_HEX, '{"a":2}', timestamp);
    expect(sigA).not.toBe(sigB);
  });

  it('is deterministic — same inputs produce the same signature every time', () => {
    const body = '{"a":1}';
    const timestamp = 1_800_000_000;
    expect(signSivihubEvent(SECRET_HEX, body, timestamp)).toBe(
      signSivihubEvent(SECRET_HEX, body, timestamp),
    );
  });
});
