/**
 * sign-payload.test.ts — Unit tests for buildSignedMetaPayload.
 *
 * LOAD-BEARING: These tests verify that the returned `payload` string (the canonical
 * serialized JSON) verifies correctly when fed back through resolveSignature.
 *
 * Docker-free: pure Vitest, no container needed.
 */

import { describe, expect, it } from 'vitest';
import { buildSignedMetaPayload } from './sign-payload.js';
import { metaPayloadSchema, resolveSignature } from './whatsapp.service.js';

const APP_SECRET = 'test-app-secret-for-hmac';

describe('buildSignedMetaPayload()', () => {
  it('returns a payload string, a sha256= signatureHeader, and a wamid', () => {
    const result = buildSignedMetaPayload({
      phone: '+51987654321',
      profileName: 'Test User',
      text: 'Hola',
      phoneNumberId: 'dev-phone-123',
      appSecret: APP_SECRET,
    });

    expect(typeof result.payload).toBe('string');
    expect(result.signatureHeader).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(typeof result.wamid).toBe('string');
    expect(result.wamid.length).toBeGreaterThan(0);
  });

  it('signatureHeader verifies correctly when payload is fed back through resolveSignature', () => {
    const result = buildSignedMetaPayload({
      phone: '+51987654321',
      profileName: 'Test User',
      text: 'Hola',
      phoneNumberId: 'dev-phone-123',
      appSecret: APP_SECRET,
    });

    // resolveSignature takes an ArrayBuffer.
    // Buffer.from(string) may share a pooled ArrayBuffer with an offset; slice to get
    // the exact bytes so byteOffset is 0 — matching what Hono's c.req.arrayBuffer() returns.
    const buf = Buffer.from(result.payload);
    const rawBodyBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const valid = resolveSignature(rawBodyBuffer, result.signatureHeader, APP_SECRET);
    expect(valid).toBe(true);
  });

  it('payload parses and passes metaPayloadSchema', () => {
    const result = buildSignedMetaPayload({
      phone: '+51987654321',
      text: 'Hello',
      phoneNumberId: 'dev-phone-123',
      appSecret: APP_SECRET,
    });

    const parsed = JSON.parse(result.payload) as unknown;
    const zodResult = metaPayloadSchema.safeParse(parsed);
    expect(zodResult.success).toBe(true);
  });

  it('wamid in the parsed payload is a non-empty string', () => {
    const result = buildSignedMetaPayload({
      phone: '+51987654321',
      text: 'Hello',
      phoneNumberId: 'dev-phone-123',
      appSecret: APP_SECRET,
    });

    const parsed = JSON.parse(result.payload) as {
      entry: Array<{
        changes: Array<{
          value: {
            messages?: Array<{ id: string }>;
          };
        }>;
      }>;
    };

    const wamidInPayload = parsed.entry[0]?.changes[0]?.value?.messages?.[0]?.id;
    expect(typeof wamidInPayload).toBe('string');
    expect(wamidInPayload!.length).toBeGreaterThan(0);
    // wamid in the returned struct must match the one in the payload
    expect(result.wamid).toBe(wamidInPayload);
  });

  it('two consecutive calls with identical inputs produce different wamid values', () => {
    const input = {
      phone: '+51987654321',
      text: 'Same text',
      phoneNumberId: 'dev-phone-123',
      appSecret: APP_SECRET,
    };

    const r1 = buildSignedMetaPayload(input);
    const r2 = buildSignedMetaPayload(input);

    expect(r1.wamid).not.toBe(r2.wamid);
  });

  it('WHATSAPP_APP_SECRET does not appear in payload or signatureHeader body', () => {
    const result = buildSignedMetaPayload({
      phone: '+51987654321',
      text: 'Secret test',
      phoneNumberId: 'dev-phone-123',
      appSecret: APP_SECRET,
    });

    expect(result.payload).not.toContain(APP_SECRET);
    // signatureHeader is sha256=<hex> — just hex digits, no secret
    expect(result.signatureHeader).not.toContain(APP_SECRET);
  });
});
