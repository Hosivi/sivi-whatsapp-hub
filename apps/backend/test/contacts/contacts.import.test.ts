/**
 * contacts.import.test.ts — Docker-free UNIT tests for importContacts().
 *
 * Uses a FAKE in-memory ContactsRepository that mirrors production semantics:
 * - invalid phone → err(INVALID_PHONE)
 * - live phone   → err(CONTACT_ALREADY_EXISTS)
 * - soft-deleted → ok(Contact) with createdAt < updatedAt  (resurrect signal)
 * - absent phone → ok(Contact) with createdAt === updatedAt (fresh-insert signal)
 * - poison phone → err(DB_ERROR)  (configurable per test)
 */

import { describe, expect, it } from 'vitest';
import type { ContactError } from '../../src/contacts/contacts.errors.js';
import { importContacts } from '../../src/contacts/contacts.import.js';
import type { ImportReport, ImportRow } from '../../src/contacts/contacts.import.js';
import type {
  ContactsRepository,
  NewContactInput,
} from '../../src/contacts/contacts.repository.js';
import { normalizePhoneE164 } from '../../src/contacts/phone-e164.js';
import type { Contact } from '../../src/db/schema/contacts.schema.js';
import { err, ok } from '../../src/shared/result.js';

// ---------------------------------------------------------------------------
// Fake in-memory repository
// ---------------------------------------------------------------------------

type PhoneState = 'live' | 'softDeleted';

function makeFakeRepo(opts: {
  seed?: Map<string, PhoneState>;
  poisonPhones?: Set<string>;
  callCounts?: Map<string, number>;
}): ContactsRepository {
  const seed: Map<string, PhoneState> = opts.seed ?? new Map();
  const poisonPhones: Set<string> = opts.poisonPhones ?? new Set();
  const callCounts: Map<string, number> = opts.callCounts ?? new Map();

  // Fake DB state mutable during a test
  const db: Map<string, PhoneState> = new Map(seed);

  const BASE_ID = '00000000-0000-0000-0000-';
  let counter = 1;

  function makeContact(phoneE164: string, isResurrect: boolean): Contact {
    const id = `${BASE_ID}${String(counter++).padStart(12, '0')}`;
    const now = new Date();
    const createdAt = isResurrect ? new Date(now.getTime() - 10_000) : now;
    const updatedAt = now;
    return {
      id,
      tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      phoneE164,
      fullName: null,
      source: null,
      tags: [],
      intent: null,
      intentConfidence: null,
      createdAt,
      updatedAt,
      deletedAt: null,
    };
  }

  const create = async (input: NewContactInput) => {
    // Normalize to match production behaviour
    const normalized = normalizePhoneE164(input.phone);
    if (!normalized.ok) {
      return err<ContactError>({ code: 'INVALID_PHONE' });
    }
    const phoneE164 = normalized.value;

    // Increment call count
    callCounts.set(phoneE164, (callCounts.get(phoneE164) ?? 0) + 1);

    // Poison phone → DB_ERROR
    if (poisonPhones.has(phoneE164)) {
      return err<ContactError>({ code: 'DB_ERROR' });
    }

    const state = db.get(phoneE164);

    if (state === 'live') {
      return err<ContactError>({ code: 'CONTACT_ALREADY_EXISTS' });
    }

    if (state === 'softDeleted') {
      db.set(phoneE164, 'live');
      return ok(makeContact(phoneE164, true));
    }

    // Absent — fresh insert
    db.set(phoneE164, 'live');
    return ok(makeContact(phoneE164, false));
  };

  // The other methods are not called by importContacts — stubs are enough.
  const notImplemented = (): never => {
    throw new Error('not called in import tests');
  };

  return {
    create,
    findById: notImplemented,
    list: notImplemented,
    update: notImplemented,
    softDelete: notImplemented,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const row = (phone: string, extra?: Partial<NewContactInput>): ImportRow => ({
  phone,
  ...extra,
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('importContacts — unit (fake repo, Docker-free)', () => {
  it('1. all-new rows → all imported, counts correct, order preserved', async () => {
    const repo = makeFakeRepo({});
    const report: ImportReport = await importContacts(repo, [
      row('987654321'),
      row('912345678'),
      row('911111111'),
    ]);

    expect(report.summary.total).toBe(3);
    expect(report.summary.imported).toBe(3);
    expect(report.summary.resurrected).toBe(0);
    expect(report.summary.skippedInvalidPhone).toBe(0);
    expect(report.summary.skippedDuplicateInBatch).toBe(0);
    expect(report.summary.skippedAlreadyExists).toBe(0);
    expect(report.summary.errors).toBe(0);

    // Order preserved
    expect(report.rows).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const r = report.rows[i];
      expect(r).toBeDefined();
      if (!r) continue;
      expect(r.index).toBe(i);
      expect(r.outcome).toBe('imported');
      // Each row echoes input
      expect(r.input).toBeDefined();
    }

    // contactId present for imported
    const r0 = report.rows[0];
    expect(r0?.outcome === 'imported' && r0.contactId).toBeTruthy();
  });

  it('2. empty phone → skipped-invalid-phone EMPTY_INPUT; malformed → INVALID_FORMAT; surrounding valid rows still imported', async () => {
    const repo = makeFakeRepo({});
    const report: ImportReport = await importContacts(repo, [
      row('987654321'), // valid
      row('   '), // empty → EMPTY_INPUT
      row('912345678'), // valid
      row('notaphone'), // malformed → INVALID_FORMAT
      row('911111111'), // valid
    ]);

    expect(report.summary.total).toBe(5);
    expect(report.summary.imported).toBe(3);
    expect(report.summary.skippedInvalidPhone).toBe(2);

    const r1 = report.rows[1];
    expect(r1?.outcome).toBe('skipped-invalid-phone');
    if (r1?.outcome === 'skipped-invalid-phone') {
      expect(r1.reason).toBe('EMPTY_INPUT');
    }

    const r3 = report.rows[3];
    expect(r3?.outcome).toBe('skipped-invalid-phone');
    if (r3?.outcome === 'skipped-invalid-phone') {
      expect(r3.reason).toBe('INVALID_FORMAT');
    }

    // Input is echoed on every row
    expect(report.rows[0]?.input.phone).toBe('987654321');
    expect(report.rows[1]?.input.phone).toBe('   ');
  });

  it('3. within-batch duplicate → first imported, second skipped-duplicate-in-batch; create called ONCE', async () => {
    const callCounts = new Map<string, number>();
    const repo = makeFakeRepo({ callCounts });

    const report: ImportReport = await importContacts(repo, [
      row('987654321'), // index 0 — first valid occurrence
      row('+51987654321'), // index 1 — same normalized phone → duplicate
    ]);

    expect(report.summary.total).toBe(2);
    expect(report.summary.imported).toBe(1);
    expect(report.summary.skippedDuplicateInBatch).toBe(1);

    const r0 = report.rows[0];
    expect(r0?.outcome).toBe('imported');
    expect(r0?.index).toBe(0);

    const r1 = report.rows[1];
    expect(r1?.outcome).toBe('skipped-duplicate-in-batch');
    if (r1?.outcome === 'skipped-duplicate-in-batch') {
      expect(r1.canonicalRowIndex).toBe(0);
    }
    expect(r1?.index).toBe(1);

    // create() called exactly once for +51987654321
    expect(callCounts.get('+51987654321')).toBe(1);
  });

  it('4. live phone in DB → skipped-already-exists', async () => {
    const seed = new Map<string, PhoneState>([['+51987654321', 'live']]);
    const repo = makeFakeRepo({ seed });

    const report: ImportReport = await importContacts(repo, [row('987654321')]);

    expect(report.summary.total).toBe(1);
    expect(report.summary.skippedAlreadyExists).toBe(1);
    expect(report.summary.imported).toBe(0);

    const r0 = report.rows[0];
    expect(r0?.outcome).toBe('skipped-already-exists');
    expect(r0?.index).toBe(0);
  });

  it('5. soft-deleted phone → resurrected, contactId present, counted in resurrected', async () => {
    const seed = new Map<string, PhoneState>([['+51987654321', 'softDeleted']]);
    const repo = makeFakeRepo({ seed });

    const report: ImportReport = await importContacts(repo, [row('987654321')]);

    expect(report.summary.total).toBe(1);
    expect(report.summary.resurrected).toBe(1);
    expect(report.summary.imported).toBe(0);

    const r0 = report.rows[0];
    expect(r0?.outcome).toBe('resurrected');
    if (r0?.outcome === 'resurrected') {
      expect(typeof r0.contactId).toBe('string');
    }
  });

  it('6. DB_ERROR phone → row status error; summary.errors === 1; remaining rows still processed', async () => {
    const poisonPhones = new Set(['+51987654321']);
    const repo = makeFakeRepo({ poisonPhones });

    const report: ImportReport = await importContacts(repo, [
      row('987654321'), // poison → error
      row('912345678'), // valid → imported
    ]);

    expect(report.summary.total).toBe(2);
    expect(report.summary.errors).toBe(1);
    expect(report.summary.imported).toBe(1);

    const r0 = report.rows[0];
    expect(r0?.outcome).toBe('error');
    if (r0?.outcome === 'error') {
      expect(r0.code).toBe('DB_ERROR');
    }

    const r1 = report.rows[1];
    expect(r1?.outcome).toBe('imported');
  });

  it('7. mixed batch (all 6 outcomes) → full summary tally equals total; rows preserve original index; each row echoes input', async () => {
    // Setup: +51987654321 live, +51912345678 soft-deleted, +51911111111 poison
    const seed = new Map<string, PhoneState>([
      ['+51987654321', 'live'],
      ['+51912345678', 'softDeleted'],
    ]);
    const poisonPhones = new Set(['+51911111111']);
    const repo = makeFakeRepo({ seed, poisonPhones });

    // Batch:
    //  0: 'not-a-phone' (invalid format)       → skipped-invalid-phone
    //  1: 987654321  (live in DB)              → skipped-already-exists
    //  2: 912345678  (soft-deleted in DB)      → resurrected
    //  3: 955555555  (new, valid)              → imported
    //  4: 955555555  (same as 3)              → skipped-duplicate-in-batch
    //  5: 911111111  (poison)                 → error
    const report: ImportReport = await importContacts(repo, [
      row('not-a-phone'), // 0 — invalid format
      row('987654321'), // 1 — live → already-exists
      row('912345678'), // 2 — soft-deleted → resurrected
      row('955555555'), // 3 — new → imported
      row('955555555'), // 4 — same as 3 → duplicate-in-batch
      row('911111111'), // 5 — poison → error
    ]);

    expect(report.summary.total).toBe(6);

    const {
      imported,
      resurrected,
      skippedInvalidPhone,
      skippedDuplicateInBatch,
      skippedAlreadyExists,
      errors,
    } = report.summary;
    expect(
      imported +
        resurrected +
        skippedInvalidPhone +
        skippedDuplicateInBatch +
        skippedAlreadyExists +
        errors,
    ).toBe(6);

    expect(skippedInvalidPhone).toBe(1);
    expect(skippedAlreadyExists).toBe(1);
    expect(resurrected).toBe(1);
    expect(imported).toBe(1);
    expect(skippedDuplicateInBatch).toBe(1);
    expect(errors).toBe(1);

    // Original index order preserved
    expect(report.rows).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(report.rows[i]?.index).toBe(i);
    }

    // Each row echoes input
    expect(report.rows[0]?.input.phone).toBe('not-a-phone');
    expect(report.rows[3]?.input.phone).toBe('955555555');

    // Status assertions
    expect(report.rows[0]?.outcome).toBe('skipped-invalid-phone');
    expect(report.rows[1]?.outcome).toBe('skipped-already-exists');
    expect(report.rows[2]?.outcome).toBe('resurrected');
    expect(report.rows[3]?.outcome).toBe('imported');
    expect(report.rows[4]?.outcome).toBe('skipped-duplicate-in-batch');
    expect(report.rows[5]?.outcome).toBe('error');
  });
});
