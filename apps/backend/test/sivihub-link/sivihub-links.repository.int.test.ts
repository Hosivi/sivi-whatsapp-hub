/**
 * sivihub-links.repository.int.test.ts — Integration tests for sivihub_links
 * (migration 0006 + repository), against a real Postgres via Testcontainers.
 *
 * Covers: the store-or-replace upsert (link storage + encryption round trip),
 * and cross-tenant RLS isolation.
 *
 * STRICT TDD MODE — written RED before the migration/repository existed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSivihubLinkSecretCipher } from '../../src/sivihub-link/sivihub-link-secret-cipher.js';
import {
  findActiveLink,
  storeOrReplaceActiveLink,
} from '../../src/sivihub-link/sivihub-links.repository.js';
import { type TestDb, createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const KEY_HEX = 'c'.repeat(64);

describe('sivihub_links (migration 0006 + repository)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('stores an encrypted secret and round-trips it through findActiveLink + the cipher', async () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const secretEncrypted = cipher.encrypt('the-raw-hmac-secret');

    await db.withTenant(TENANT_A, (tx) =>
      storeOrReplaceActiveLink(
        tx,
        TENANT_A,
        'https://sivihub.pe/api/hooks/ventas/x',
        secretEncrypted,
      ),
    );

    const link = await db.withTenant(TENANT_A, (tx) => findActiveLink(tx, TENANT_A));
    expect(link).not.toBeNull();
    expect(link?.eventsUrl).toBe('https://sivihub.pe/api/hooks/ventas/x');
    // The stored value is the CIPHERTEXT, never the plaintext.
    expect(link?.secretEncrypted).toBe(secretEncrypted);
    expect(link?.secretEncrypted).not.toContain('the-raw-hmac-secret');
    expect(cipher.decrypt(link?.secretEncrypted ?? '')).toBe('the-raw-hmac-secret');
  });

  it('the raw secret_encrypted column value is never plaintext (admin read)', async () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const secretEncrypted = cipher.encrypt('another-raw-secret');

    await db.withTenant(TENANT_A, (tx) =>
      storeOrReplaceActiveLink(
        tx,
        TENANT_A,
        'https://sivihub.pe/api/hooks/ventas/x',
        secretEncrypted,
      ),
    );

    const rows = await db.adminSql`SELECT secret_encrypted FROM sivihub_links`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secret_encrypted).toContain('v1:');
    expect(rows[0]?.secret_encrypted).not.toContain('another-raw-secret');
  });

  it('re-running the upsert REPLACES the tenant active link in place (one row)', async () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);

    await db.withTenant(TENANT_A, (tx) =>
      storeOrReplaceActiveLink(
        tx,
        TENANT_A,
        'https://sivihub.pe/first-url',
        cipher.encrypt('secret-1'),
      ),
    );
    await db.withTenant(TENANT_A, (tx) =>
      storeOrReplaceActiveLink(
        tx,
        TENANT_A,
        'https://sivihub.pe/second-url',
        cipher.encrypt('secret-2'),
      ),
    );

    const rows =
      await db.adminSql`SELECT events_url FROM sivihub_links WHERE tenant_id = ${TENANT_A}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.events_url).toBe('https://sivihub.pe/second-url');
  });

  it('findActiveLink returns null when the tenant has no active link', async () => {
    const link = await db.withTenant(TENANT_A, (tx) => findActiveLink(tx, TENANT_A));
    expect(link).toBeNull();
  });

  it('RLS isolates sivihub_links across tenants — tenant B never sees tenant A link', async () => {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    await db.withTenant(TENANT_A, (tx) =>
      storeOrReplaceActiveLink(tx, TENANT_A, 'https://sivihub.pe/a', cipher.encrypt('secret-a')),
    );

    const linkForB = await db.withTenant(TENANT_B, (tx) => findActiveLink(tx, TENANT_B));
    expect(linkForB).toBeNull();
  });
});
