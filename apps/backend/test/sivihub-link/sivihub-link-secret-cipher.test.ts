/**
 * sivihub-link-secret-cipher.test.ts — Unit tests for the AES-256-GCM cipher used
 * by sivihub_links.secret_encrypted.
 *
 * Pure Vitest — no DB, no Testcontainers.
 * STRICT TDD MODE — written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import { createSivihubLinkSecretCipher } from '../../src/sivihub-link/sivihub-link-secret-cipher.js';

const KEY_HEX = 'a'.repeat(64); // 32 bytes hex
const OTHER_KEY_HEX = 'b'.repeat(64);

describe('createSivihubLinkSecretCipher', () => {
  it('round trip: decrypt(encrypt(secret)) === secret', () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const secret = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const encrypted = cipher.encrypt(secret);
    expect(cipher.decrypt(encrypted)).toBe(secret);
  });

  it('output is prefixed with the "v1:" version marker', () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const encrypted = cipher.encrypt('super-secret');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted.split(':')).toHaveLength(4);
  });

  it('two encryptions of the same plaintext produce different ciphertext (random IV)', () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const a = cipher.encrypt('same-secret');
    const b = cipher.encrypt('same-secret');
    expect(a).not.toBe(b);
  });

  it('decrypt returns null for a malformed payload (wrong shape)', () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    expect(cipher.decrypt('not-a-valid-payload')).toBeNull();
  });

  it('decrypt returns null for an unknown version prefix', () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const encrypted = cipher.encrypt('secret');
    const tampered = `v2:${encrypted.slice(3)}`;
    expect(cipher.decrypt(tampered)).toBeNull();
  });

  it('decrypt returns null when the ciphertext is tampered (auth tag mismatch)', () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const encrypted = cipher.encrypt('secret-value');
    const parts = encrypted.split(':');
    const ciphertext = parts[3] as string;
    const flippedFirstChar = ciphertext[0] === '0' ? '1' : '0';
    const tamperedCiphertext = flippedFirstChar + ciphertext.slice(1);
    const tampered = [parts[0], parts[1], parts[2], tamperedCiphertext].join(':');
    expect(cipher.decrypt(tampered)).toBeNull();
  });

  it('decrypt returns null when the wrong key is used', () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const otherCipher = createSivihubLinkSecretCipher(OTHER_KEY_HEX);
    const encrypted = cipher.encrypt('secret-for-tenant');
    expect(otherCipher.decrypt(encrypted)).toBeNull();
  });

  it('never throws — decrypt swallows every failure mode', () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    expect(() => cipher.decrypt('')).not.toThrow();
    expect(() => cipher.decrypt('v1:::')).not.toThrow();
    expect(() => cipher.decrypt('v1:zz:zz:zz')).not.toThrow();
  });
});
