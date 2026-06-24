/**
 * contacts.repository.int.test.ts — Integration tests for ContactsRepository.
 *
 * All assertions run through the app_rls-scoped TenantRunner (RLS enforced).
 * Each describe block gets its own createTestDb() instance for isolation.
 *
 * Testcontainers note: container startup can take 30–60s on cold pull.
 */

import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createContactsRepository,
  upsertContactTx,
} from '../../src/contacts/contacts.repository.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const VALID_PHONE = '987654321'; // normalizes to +51987654321
const VALID_PHONE_2 = '912345678'; // normalizes to +51912345678
const INVALID_PHONE = 'not-a-phone';

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe('ContactsRepository.create', () => {
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

  it('happy path: creates a contact, stores normalized E.164 phone, deletedAt is null', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const result = await repo.create({ phone: VALID_PHONE, fullName: 'Alice' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const contact = result.value;
    expect(contact.phoneE164).toBe('+51987654321');
    expect(contact.fullName).toBe('Alice');
    expect(contact.tenantId).toBe(TENANT_A);
    expect(contact.deletedAt).toBeNull();
    expect(typeof contact.id).toBe('string');
  });

  it('returns CONTACT_ALREADY_EXISTS for a live phone conflict', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    await repo.create({ phone: VALID_PHONE, fullName: 'Alice' });
    const result = await repo.create({ phone: VALID_PHONE, fullName: 'Alice Duplicate' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTACT_ALREADY_EXISTS');
  });

  it('resurrects a soft-deleted contact with the same id, clears deletedAt', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);

    // Create and soft-delete
    const firstResult = await repo.create({ phone: VALID_PHONE, fullName: 'Alice' });
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;
    const originalId = firstResult.value.id;

    await repo.softDelete(originalId);

    // Resurrect
    const resurrected = await repo.create({ phone: VALID_PHONE, fullName: 'Alice Resurrected' });
    expect(resurrected.ok).toBe(true);
    if (!resurrected.ok) return;

    expect(resurrected.value.id).toBe(originalId); // same id
    expect(resurrected.value.deletedAt).toBeNull();
    expect(resurrected.value.fullName).toBe('Alice Resurrected');
  });

  it('returns INVALID_PHONE for an invalid phone string', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const result = await repo.create({ phone: INVALID_PHONE });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PHONE');
  });
});

// ---------------------------------------------------------------------------
// findById()
// ---------------------------------------------------------------------------

describe('ContactsRepository.findById', () => {
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

  it('returns the contact when it exists and is active', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const createResult = await repo.create({ phone: VALID_PHONE, fullName: 'Bob' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const findResult = await repo.findById(createResult.value.id);
    expect(findResult.ok).toBe(true);
    if (!findResult.ok) return;
    expect(findResult.value.id).toBe(createResult.value.id);
  });

  it('returns CONTACT_NOT_FOUND for a soft-deleted contact', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const createResult = await repo.create({ phone: VALID_PHONE, fullName: 'Carol' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await repo.softDelete(createResult.value.id);

    const findResult = await repo.findById(createResult.value.id);
    expect(findResult.ok).toBe(false);
    if (findResult.ok) return;
    expect(findResult.error.code).toBe('CONTACT_NOT_FOUND');
  });

  it('returns CONTACT_NOT_FOUND for a missing id', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const result = await repo.findById('00000000-0000-0000-0000-000000000000');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTACT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('ContactsRepository.list', () => {
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

  it('returns empty array when no contacts exist', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const result = await repo.list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('excludes soft-deleted contacts', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const c1 = await repo.create({ phone: VALID_PHONE });
    const c2 = await repo.create({ phone: VALID_PHONE_2 });
    expect(c1.ok && c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;

    await repo.softDelete(c1.value.id);

    const listResult = await repo.list();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    expect(listResult.value).toHaveLength(1);
    expect(listResult.value[0]?.id).toBe(c2.value.id);
  });

  it('orders results by createdAt DESC', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const c1 = await repo.create({ phone: VALID_PHONE });
    // small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 50));
    const c2 = await repo.create({ phone: VALID_PHONE_2 });
    expect(c1.ok && c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;

    const listResult = await repo.list();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    expect(listResult.value[0]?.id).toBe(c2.value.id); // newest first
    expect(listResult.value[1]?.id).toBe(c1.value.id);
  });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe('ContactsRepository.update', () => {
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

  it('applies a partial patch without touching unpatched fields', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const created = await repo.create({ phone: VALID_PHONE, fullName: 'Dave', source: 'web' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await repo.update(created.value.id, { fullName: 'Dave Updated' });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.value.fullName).toBe('Dave Updated');
    expect(updated.value.source).toBe('web'); // unchanged
    expect(updated.value.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created.value.updatedAt.getTime(),
    );
  });

  it('returns CONTACT_NOT_FOUND for a soft-deleted target', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const created = await repo.create({ phone: VALID_PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await repo.softDelete(created.value.id);

    const result = await repo.update(created.value.id, { fullName: 'Ghost' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTACT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// softDelete()
// ---------------------------------------------------------------------------

describe('ContactsRepository.softDelete', () => {
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

  it('soft-deletes an active contact', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const created = await repo.create({ phone: VALID_PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await repo.softDelete(created.value.id);
    expect(result.ok).toBe(true);

    // findById should now return CONTACT_NOT_FOUND
    const found = await repo.findById(created.value.id);
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe('CONTACT_NOT_FOUND');
  });

  it('is idempotent on an already-deleted contact', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const created = await repo.create({ phone: VALID_PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await repo.softDelete(created.value.id);
    const second = await repo.softDelete(created.value.id);
    expect(second.ok).toBe(true); // idempotent — no error
  });

  it('returns CONTACT_NOT_FOUND for a missing id', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const result = await repo.softDelete('00000000-0000-0000-0000-000000000000');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTACT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// intentConfidence — NUMERIC → number type assertion
// ---------------------------------------------------------------------------

describe('ContactsRepository — intentConfidence is typeof number', () => {
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

  it('returns intentConfidence as a JS number, not a string', async () => {
    // Seed directly via admin to set intent_confidence
    await db.seedTenant(TENANT_A, { phoneE164: '+51987654321', fullName: 'Eve' });

    // Manually update intent_confidence via adminQuery
    await db.adminQuery(async (tx) => {
      await tx.execute(
        rawSql`UPDATE contacts SET intent_confidence = 0.9500 WHERE phone_e164 = '+51987654321'`,
      );
    });

    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const found = await repo.list();
    expect(found.ok).toBe(true);
    if (!found.ok) return;

    const contact = found.value[0];
    expect(contact).toBeDefined();
    if (!contact) return;
    expect(typeof contact.intentConfidence).toBe('number');
    expect(contact.intentConfidence).toBeCloseTo(0.95, 4);
  });
});

// ---------------------------------------------------------------------------
// upsertContactTx — tx-bound upsert-or-reuse helper
// ---------------------------------------------------------------------------
// Extraction guard: upsertContactTx must NOT change the public behavior of create().
// create() still returns CONTACT_ALREADY_EXISTS for a live phone conflict.

describe('upsertContactTx — upsert-or-reuse semantics', () => {
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

  it('inserts a new contact and returns ok(newContact) for a fresh phone', async () => {
    let contactId: string | undefined;
    await db.withTenant(TENANT_A, async (tx) => {
      const result = await upsertContactTx(tx, TENANT_A, {
        phone: VALID_PHONE,
        source: 'whatsapp',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phoneE164).toBe('+51987654321');
      expect(result.value.source).toBe('whatsapp');
      contactId = result.value.id;
    });
    expect(contactId).toBeDefined();
  });

  it('returns ok(existingContact) for a LIVE existing contact (reuse, NOT CONTACT_ALREADY_EXISTS)', async () => {
    // First create via repo
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const first = await repo.create({ phone: VALID_PHONE, fullName: 'Alice' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const originalId = first.value.id;

    // upsertContactTx on the same live phone → reuse, not error
    await db.withTenant(TENANT_A, async (tx) => {
      const result = await upsertContactTx(tx, TENANT_A, {
        phone: VALID_PHONE,
        source: 'whatsapp',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Returns the existing contact — same id
      expect(result.value.id).toBe(originalId);
    });
  });

  it('resurrects a soft-deleted contact and returns ok(resurrectedContact)', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    const created = await repo.create({ phone: VALID_PHONE, fullName: 'Bob' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const originalId = created.value.id;

    await repo.softDelete(originalId);

    await db.withTenant(TENANT_A, async (tx) => {
      const result = await upsertContactTx(tx, TENANT_A, {
        phone: VALID_PHONE,
        source: 'whatsapp',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Same id (resurrected)
      expect(result.value.id).toBe(originalId);
      expect(result.value.deletedAt).toBeNull();
    });
  });

  it('returns INVALID_PHONE for an invalid phone string', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const result = await upsertContactTx(tx, TENANT_A, { phone: INVALID_PHONE });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_PHONE');
    });
  });
});

// ---------------------------------------------------------------------------
// create() no-regression after upsertContactTx extraction
// ---------------------------------------------------------------------------

describe('create() still returns CONTACT_ALREADY_EXISTS for a live duplicate (upsertContactTx extraction regression guard)', () => {
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

  it('create() with a live phone duplicate still returns err(CONTACT_ALREADY_EXISTS)', async () => {
    const repo = createContactsRepository(db.withTenant, TENANT_A);
    await repo.create({ phone: VALID_PHONE, fullName: 'Alice' });
    const result = await repo.create({ phone: VALID_PHONE, fullName: 'Duplicate Alice' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTACT_ALREADY_EXISTS');
  });
});
