/**
 * contacts.import.ts — Bulk import service for contacts.
 *
 * importContacts(repo, rows): pure orchestration over the ContactsRepository port.
 * It NEVER opens a transaction, NEVER calls withTenant, NEVER throws.
 * Per-row DB calls go through repo.create() which owns its own withTenant tx.
 *
 * Row pipeline (per original index i):
 *   (a) normalizePhoneE164  — err → skipped-invalid-phone
 *   (b) in-batch dedup      — seen → skipped-duplicate-in-batch
 *   (c) repo.create(row)    — ok  → imported | resurrected (by timestamp comparison)
 *                           — err → skipped-already-exists | skipped-invalid-phone | error
 *
 * imported vs resurrected: contact.createdAt < contact.updatedAt → resurrected.
 * Fresh INSERT: createdAt === updatedAt (both from DB now() same statement).
 * Resurrect UPDATE: only updatedAt is set to new Date(), createdAt stays old → strictly less.
 *
 * DB_ERROR policy: per-row `error` outcome; route returns 500 if summary.errors > 0.
 */

import type { ContactsRepository, NewContactInput } from './contacts.repository.js';
import type { PhoneNormalizationErrorCode } from './phone-e164.js';
import { normalizePhoneE164 } from './phone-e164.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One submitted import row — identical shape to NewContactInput. */
export type ImportRow = NewContactInput;

export type RowOutcome =
  | {
      readonly index: number;
      readonly input: ImportRow;
      readonly outcome: 'imported';
      readonly contactId: string;
    }
  | {
      readonly index: number;
      readonly input: ImportRow;
      readonly outcome: 'resurrected';
      readonly contactId: string;
    }
  | {
      readonly index: number;
      readonly input: ImportRow;
      readonly outcome: 'skipped-invalid-phone';
      readonly reason: PhoneNormalizationErrorCode;
    }
  | {
      readonly index: number;
      readonly input: ImportRow;
      readonly outcome: 'skipped-duplicate-in-batch';
      readonly canonicalRowIndex: number;
    }
  | {
      readonly index: number;
      readonly input: ImportRow;
      readonly outcome: 'skipped-already-exists';
    }
  | {
      readonly index: number;
      readonly input: ImportRow;
      readonly outcome: 'error';
      readonly code: 'DB_ERROR';
    };

export type ImportSummary = {
  readonly total: number;
  readonly imported: number;
  readonly resurrected: number;
  readonly skippedInvalidPhone: number;
  readonly skippedDuplicateInBatch: number;
  readonly skippedAlreadyExists: number;
  readonly errors: number;
};

export type ImportReport = {
  readonly summary: ImportSummary;
  readonly rows: ReadonlyArray<RowOutcome>;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * importContacts — processes a batch of rows against the provided repo.
 *
 * @param repo - ContactsRepository already bound to a specific tenant (functional DI).
 * @param rows - Input rows in submission order. Index is their 0-based position here.
 * @returns A fully-resolved ImportReport. Never rejects.
 */
export const importContacts = async (
  repo: ContactsRepository,
  rows: ReadonlyArray<ImportRow>,
): Promise<ImportReport> => {
  const outcomes: RowOutcome[] = [];

  // Running dedup structures (keyed on normalized E.164 string)
  const seenPhones = new Set<string>();
  const firstIndex = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const inputRow = rows[i];
    // noUncheckedIndexedAccess: rows[i] can be undefined in TS strict mode
    if (inputRow === undefined) continue;

    // (a) Normalize
    const normalResult = normalizePhoneE164(inputRow.phone);
    if (!normalResult.ok) {
      outcomes.push({
        index: i,
        input: inputRow,
        outcome: 'skipped-invalid-phone',
        reason: normalResult.error.code,
      });
      continue;
    }
    const phoneE164 = normalResult.value;

    // (b) In-batch dedup
    if (seenPhones.has(phoneE164)) {
      const canonical = firstIndex.get(phoneE164);
      // firstIndex is always set when seenPhones has the key
      outcomes.push({
        index: i,
        input: inputRow,
        outcome: 'skipped-duplicate-in-batch',
        canonicalRowIndex: canonical ?? i,
      });
      continue;
    }
    seenPhones.add(phoneE164);
    firstIndex.set(phoneE164, i);

    // (c) Persist
    const createResult = await repo.create(inputRow);

    if (createResult.ok) {
      const contact = createResult.value;
      const resurrected = contact.createdAt.getTime() < contact.updatedAt.getTime();
      outcomes.push(
        resurrected
          ? { index: i, input: inputRow, outcome: 'resurrected', contactId: contact.id }
          : { index: i, input: inputRow, outcome: 'imported', contactId: contact.id },
      );
    } else {
      switch (createResult.error.code) {
        case 'CONTACT_ALREADY_EXISTS':
          outcomes.push({ index: i, input: inputRow, outcome: 'skipped-already-exists' });
          break;
        case 'INVALID_PHONE':
          outcomes.push({
            index: i,
            input: inputRow,
            outcome: 'skipped-invalid-phone',
            reason: 'INVALID_FORMAT',
          });
          break;
        case 'DB_ERROR':
          outcomes.push({ index: i, input: inputRow, outcome: 'error', code: 'DB_ERROR' });
          break;
        case 'CONTACT_NOT_FOUND':
          // create() never returns CONTACT_NOT_FOUND — defensive fallthrough
          outcomes.push({ index: i, input: inputRow, outcome: 'error', code: 'DB_ERROR' });
          break;
      }
    }
  }

  // Tally summary from outcomes (single source of truth — counts can't drift)
  let imported = 0;
  let resurrected = 0;
  let skippedInvalidPhone = 0;
  let skippedDuplicateInBatch = 0;
  let skippedAlreadyExists = 0;
  let errors = 0;

  for (const row of outcomes) {
    switch (row.outcome) {
      case 'imported':
        imported++;
        break;
      case 'resurrected':
        resurrected++;
        break;
      case 'skipped-invalid-phone':
        skippedInvalidPhone++;
        break;
      case 'skipped-duplicate-in-batch':
        skippedDuplicateInBatch++;
        break;
      case 'skipped-already-exists':
        skippedAlreadyExists++;
        break;
      case 'error':
        errors++;
        break;
    }
  }

  const summary: ImportSummary = {
    total: rows.length,
    imported,
    resurrected,
    skippedInvalidPhone,
    skippedDuplicateInBatch,
    skippedAlreadyExists,
    errors,
  };

  return { summary, rows: outcomes };
};
