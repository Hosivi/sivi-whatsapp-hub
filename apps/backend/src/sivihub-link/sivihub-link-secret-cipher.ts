/**
 * sivihub-link-secret-cipher.ts — AES-256-GCM encryption for sivihub_links.secret_encrypted
 * (ADR-0048 corte 1, walking skeleton B1).
 *
 * Mirrors the versioned payload shape SiviHub's own secretBox precedent uses (see
 * slice-04-ventas-redes-corte-1-hub.md, "Lo medido antes de escribir esto"):
 *   v1:<iv-hex>:<tag-hex>:<ciphertext-hex>
 * A version prefix lets a future v2 scheme coexist during key rotation without a
 * migration that touches every row.
 *
 * The key (SIVIHUB_LINK_ENCRYPTION_KEY) is meant to back a SINGLE instance created
 * once at composition time (main.ts / the sivihub:link CLI entrypoint) — never
 * re-derived per call. NEVER logs the plaintext secret or the key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96-bit IV — the GCM-recommended size.
const AUTH_TAG_LENGTH_BYTES = 16; // Standard GCM authentication tag length.
const VERSION_PREFIX = 'v1';

export type SivihubLinkSecretCipher = {
  /** Encrypts plaintext → "v1:<iv-hex>:<tag-hex>:<ciphertext-hex>". */
  encrypt(plaintext: string): string;
  /**
   * Decrypts a "v1:…" payload. Returns null — NEVER throws — on any failure: wrong
   * version, malformed shape, wrong key, or a tampered ciphertext/tag. Mirrors the
   * `cipher.decrypt` contract SiviHub's receiver relies on (401 on null, never a 500).
   */
  decrypt(encrypted: string): string | null;
};

/**
 * Creates the cipher instance. `keyHex` MUST be 64 hex chars (32 bytes) — validated by
 * envSchema (SIVIHUB_LINK_ENCRYPTION_KEY) before this is ever called.
 */
export function createSivihubLinkSecretCipher(keyHex: string): SivihubLinkSecretCipher {
  const key = Buffer.from(keyHex, 'hex');

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LENGTH_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION_PREFIX,
        iv.toString('hex'),
        tag.toString('hex'),
        ciphertext.toString('hex'),
      ].join(':');
    },

    decrypt(encrypted: string): string | null {
      const parts = encrypted.split(':');
      if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
        return null;
      }
      const [, ivHex, tagHex, ciphertextHex] = parts as [string, string, string, string];

      try {
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const ciphertext = Buffer.from(ciphertextHex, 'hex');
        if (iv.length !== IV_LENGTH_BYTES || tag.length !== AUTH_TAG_LENGTH_BYTES) {
          return null;
        }

        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plaintext.toString('utf8');
      } catch {
        // Wrong key, tampered ciphertext/tag, or malformed hex — all collapse to null.
        return null;
      }
    },
  };
}
