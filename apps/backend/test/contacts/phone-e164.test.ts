import { describe, expect, it } from 'vitest';
import {
  type PhoneNormalizationError,
  detectPhoneDuplicates,
  normalizePhoneBatch,
  normalizePhoneE164,
} from '../../src/contacts/phone-e164.js';
import { err, isErr, isOk, ok } from '../../src/shared/result.js';

// ---------------------------------------------------------------------------
// Result<T,E> helpers
// ---------------------------------------------------------------------------

describe('Result helpers', () => {
  it('ok() produces a success variant', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it('err() produces a failure variant', () => {
    const error: PhoneNormalizationError = { code: 'INVALID_FORMAT', input: 'bad' };
    const result = err(error);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual(error);
  });

  it('isOk() returns true on a success result', () => {
    const r = ok('hello');
    expect(isOk(r)).toBe(true);
  });

  it('isOk() returns false on a failure result', () => {
    const r = err({ code: 'EMPTY_INPUT', input: '' } satisfies PhoneNormalizationError);
    expect(isOk(r)).toBe(false);
  });

  it('isErr() returns true on a failure result', () => {
    const r = err({ code: 'EMPTY_INPUT', input: '' } satisfies PhoneNormalizationError);
    expect(isErr(r)).toBe(true);
  });

  it('isErr() returns false on a success result', () => {
    const r = ok('+51987654321');
    expect(isErr(r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizePhoneE164 — valid inputs
// ---------------------------------------------------------------------------

describe('normalizePhoneE164 — valid inputs', () => {
  it.each([
    ['+51987654321', 'already E.164'],
    ['51987654321', 'country prefix without plus sign'],
    ['987654321', 'bare 9-digit local mobile'],
    ['+51 987 654 321', 'E.164 with spaces'],
    ['(+51) 987-654-321', 'formatted with parentheses and hyphens'],
  ])('normalizes "%s" (%s) → +51987654321', (input) => {
    const result = normalizePhoneE164(input);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe('+51987654321');
    }
  });
});

// ---------------------------------------------------------------------------
// normalizePhoneE164 — invalid inputs
// ---------------------------------------------------------------------------

describe('normalizePhoneE164 — invalid inputs', () => {
  it('empty string → EMPTY_INPUT, input echoed', () => {
    const result = normalizePhoneE164('');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('EMPTY_INPUT');
      expect(result.error.input).toBe('');
    }
  });

  it('whitespace-only string → EMPTY_INPUT, input echoed', () => {
    const result = normalizePhoneE164('   ');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('EMPTY_INPUT');
      expect(result.error.input).toBe('   ');
    }
  });

  it.each([
    ['12345', 'too-short digit string'],
    ['12345678', '8-digit local number not starting with 9'],
    ['014561234', 'Lima landline format (9 digits, first digit != 9)'],
    ['abcdef', 'alphabetic / garbage input'],
    ['9876543210', '10 local digits (one digit too many)'],
  ])('"%s" (%s) → INVALID_FORMAT, input echoed', (input) => {
    const result = normalizePhoneE164(input);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('INVALID_FORMAT');
      expect(result.error.input).toBe(input);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizePhoneBatch
// ---------------------------------------------------------------------------

describe('normalizePhoneBatch', () => {
  it('partitions a mixed batch, preserving order within each bucket', () => {
    const report = normalizePhoneBatch(['+51987654321', 'abcdef', '987654321', '']);

    expect(report.valid).toHaveLength(2);
    expect(report.valid[0]).toEqual({ input: '+51987654321', phoneE164: '+51987654321' });
    expect(report.valid[1]).toEqual({ input: '987654321', phoneE164: '+51987654321' });

    expect(report.invalid).toHaveLength(2);
    expect(report.invalid[0]).toEqual({
      input: 'abcdef',
      error: { code: 'INVALID_FORMAT', input: 'abcdef' },
    });
    expect(report.invalid[1]).toEqual({
      input: '',
      error: { code: 'EMPTY_INPUT', input: '' },
    });
  });

  it('returns empty buckets for an empty array', () => {
    const report = normalizePhoneBatch([]);
    expect(report.valid).toEqual([]);
    expect(report.invalid).toEqual([]);
  });

  it('all-valid batch: valid bucket filled, invalid is empty', () => {
    const report = normalizePhoneBatch(['+51987654321', '51987654321', '987654321']);
    expect(report.valid).toHaveLength(3);
    for (const entry of report.valid) {
      expect(entry.phoneE164).toBe('+51987654321');
    }
    expect(report.invalid).toEqual([]);
  });

  it('all-invalid batch: invalid bucket filled with correct codes, valid is empty', () => {
    const report = normalizePhoneBatch(['', 'abc', '12345']);
    expect(report.valid).toEqual([]);
    expect(report.invalid).toHaveLength(3);
    expect(report.invalid[0]?.error.code).toBe('EMPTY_INPUT');
    expect(report.invalid[1]?.error.code).toBe('INVALID_FORMAT');
    expect(report.invalid[2]?.error.code).toBe('INVALID_FORMAT');
  });
});

// ---------------------------------------------------------------------------
// detectPhoneDuplicates
// ---------------------------------------------------------------------------

describe('detectPhoneDuplicates', () => {
  it('no duplicates: empty duplicates array, uniqueCount equals distinct count', () => {
    const report = detectPhoneDuplicates(['+51987654321', '+51912345678', '+51998765432']);
    expect(report.duplicates).toEqual([]);
    expect(report.uniqueCount).toBe(3);
  });

  it('one duplicate pair: correct group and indexes', () => {
    const report = detectPhoneDuplicates(['+51987654321', '+51912345678', '+51987654321']);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]).toEqual({ phoneE164: '+51987654321', indexes: [0, 2] });
    expect(report.uniqueCount).toBe(2);
  });

  it('triplicate plus a unique: group has 3 indexes', () => {
    const report = detectPhoneDuplicates([
      '+51987654321',
      '+51912345678',
      '+51987654321',
      '+51987654321',
    ]);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]).toEqual({ phoneE164: '+51987654321', indexes: [0, 2, 3] });
    expect(report.uniqueCount).toBe(2);
  });

  it('multiple duplicate groups: both groups in first-occurrence order', () => {
    const report = detectPhoneDuplicates([
      '+51987654321',
      '+51912345678',
      '+51987654321',
      '+51912345678',
    ]);
    expect(report.duplicates).toHaveLength(2);
    expect(report.duplicates[0]).toEqual({ phoneE164: '+51987654321', indexes: [0, 2] });
    expect(report.duplicates[1]).toEqual({ phoneE164: '+51912345678', indexes: [1, 3] });
    expect(report.uniqueCount).toBe(2);
  });

  it('empty array: no duplicates, uniqueCount is 0', () => {
    const report = detectPhoneDuplicates([]);
    expect(report.duplicates).toEqual([]);
    expect(report.uniqueCount).toBe(0);
  });

  it('single element cannot be a duplicate', () => {
    const report = detectPhoneDuplicates(['+51987654321']);
    expect(report.duplicates).toEqual([]);
    expect(report.uniqueCount).toBe(1);
  });
});
