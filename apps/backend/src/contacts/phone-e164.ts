import { type Result, err, isOk, ok } from '../shared/result.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type PhoneNormalizationErrorCode = 'EMPTY_INPUT' | 'INVALID_FORMAT';

export type PhoneNormalizationError = {
  readonly code: PhoneNormalizationErrorCode;
  readonly input: string;
};

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type NormalizedEntry = {
  readonly input: string;
  readonly phoneE164: string;
};

export type InvalidEntry = {
  readonly input: string;
  readonly error: PhoneNormalizationError;
};

export type NormalizationReport = {
  readonly valid: ReadonlyArray<NormalizedEntry>;
  readonly invalid: ReadonlyArray<InvalidEntry>;
};

export type DuplicateGroup = {
  readonly phoneE164: string;
  readonly indexes: ReadonlyArray<number>;
};

export type DedupeReport = {
  readonly duplicates: ReadonlyArray<DuplicateGroup>;
  readonly uniqueCount: number;
};

// ---------------------------------------------------------------------------
// normalizePhoneE164
//
// Algorithm (order matters):
//   1. trim() === '' → EMPTY_INPUT (raw echoed)
//   2. strip all non-digits
//   3. if 11 digits starting with '51' → drop country prefix → 9 digits
//   4. must match /^9\d{8}$/ → else INVALID_FORMAT (raw echoed)
//   5. return ok('+51' + digits)
// ---------------------------------------------------------------------------

export const normalizePhoneE164 = (input: string): Result<string, PhoneNormalizationError> => {
  if (input.trim() === '') {
    return err({ code: 'EMPTY_INPUT', input });
  }

  let digits = input.replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('51')) {
    digits = digits.slice(2);
  }

  if (!/^9\d{8}$/.test(digits)) {
    return err({ code: 'INVALID_FORMAT', input });
  }

  return ok(`+51${digits}`);
};

// ---------------------------------------------------------------------------
// normalizePhoneBatch
//
// Maps each input through normalizePhoneE164 and partitions into valid/invalid
// buckets. Relative order within each bucket is preserved.
// ---------------------------------------------------------------------------

export const normalizePhoneBatch = (inputs: ReadonlyArray<string>): NormalizationReport => {
  const valid: NormalizedEntry[] = [];
  const invalid: InvalidEntry[] = [];

  for (const input of inputs) {
    const result = normalizePhoneE164(input);
    if (isOk(result)) {
      valid.push({ input, phoneE164: result.value });
    } else {
      invalid.push({ input, error: result.error });
    }
  }

  return { valid, invalid };
};

// ---------------------------------------------------------------------------
// detectPhoneDuplicates
//
// Operates on already-normalized E.164 strings. Groups by exact string match.
// Reports only groups with 2+ members. uniqueCount = number of distinct values.
// Indexes are 0-based; groups are ordered by first occurrence; indexes within
// a group are ascending.
//
// noUncheckedIndexedAccess guard: Map.get() is always checked !== undefined
// before push to satisfy TS strict mode.
// ---------------------------------------------------------------------------

export const detectPhoneDuplicates = (phones: ReadonlyArray<string>): DedupeReport => {
  const map = new Map<string, number[]>();
  const order: string[] = [];

  for (let i = 0; i < phones.length; i++) {
    const value = phones[i];
    if (value === undefined) continue;

    const existing = map.get(value);
    if (existing === undefined) {
      map.set(value, [i]);
      order.push(value);
    } else {
      existing.push(i);
    }
  }

  const duplicates: DuplicateGroup[] = [];
  for (const key of order) {
    const list = map.get(key);
    if (list !== undefined && list.length >= 2) {
      duplicates.push({ phoneE164: key, indexes: list });
    }
  }

  return { duplicates, uniqueCount: order.length };
};
