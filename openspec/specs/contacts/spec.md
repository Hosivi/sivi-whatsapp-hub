# Specification — contacts

> Domain: contacts · Project: sivi-whatsapp-hub
> This is the main contacts domain specification, built from contact-phone-e164-dedupe (2026-06-22).

## Purpose

Establish the canonical domain types and behaviors for the WhatsApp Hub's contact management system. This slice introduces the Result<T,E> primitive (used project-wide) and E.164 phone normalization + deduplication detection for Peru mobiles.

---

## Requirements

### Requirement: Result Type and Helpers

The system MUST expose a `Result<T, E>` discriminated union at `apps/backend/src/shared/result.ts` with the following shape and helpers. This shape is the project-wide canonical form; no alternative Result type is permitted.

- `Ok<T>` = `{ readonly ok: true; readonly value: T }`
- `Err<E>` = `{ readonly ok: false; readonly error: E }`
- `Result<T, E>` = `Ok<T> | Err<E>`
- `ok<T>(value: T): Ok<T>` — constructs a success variant
- `err<E>(error: E): Err<E>` — constructs a failure variant
- `isOk<T, E>(r: Result<T, E>): r is Ok<T>` — narrows to `Ok<T>`
- `isErr<T, E>(r: Result<T, E>): r is Err<E>` — narrows to `Err<E>`

All fields MUST be `readonly`. Helpers MUST be exported named exports.

#### Scenario: ok helper produces a success variant

- GIVEN a value `42`
- WHEN `ok(42)` is called
- THEN the result is `{ ok: true, value: 42 }`
- AND `result.ok` is `true`
- AND `result.value` is `42`

#### Scenario: err helper produces a failure variant

- GIVEN an error object `{ code: 'INVALID_FORMAT', input: 'bad' }`
- WHEN `err({ code: 'INVALID_FORMAT', input: 'bad' })` is called
- THEN the result is `{ ok: false, error: { code: 'INVALID_FORMAT', input: 'bad' } }`
- AND `result.ok` is `false`

#### Scenario: isOk narrows correctly on a success result

- GIVEN `const r = ok('hello')`
- WHEN `isOk(r)` is called
- THEN it returns `true`

#### Scenario: isOk returns false on a failure result

- GIVEN `const r = err({ code: 'EMPTY_INPUT', input: '' })`
- WHEN `isOk(r)` is called
- THEN it returns `false`

#### Scenario: isErr narrows correctly on a failure result

- GIVEN `const r = err({ code: 'EMPTY_INPUT', input: '' })`
- WHEN `isErr(r)` is called
- THEN it returns `true`

#### Scenario: isErr returns false on a success result

- GIVEN `const r = ok('+51987654321')`
- WHEN `isErr(r)` is called
- THEN it returns `false`

---

### Requirement: PhoneNormalizationError Type

The system MUST define `PhoneNormalizationError` as:

```
{ readonly code: 'EMPTY_INPUT' | 'INVALID_FORMAT'; readonly input: string }
```

`input` MUST carry the original raw string passed by the caller (not a trimmed or stripped version). No other error codes are permitted in this slice.

---

### Requirement: normalizePhoneE164 — Valid Inputs

`normalizePhoneE164(input: string): Result<string, PhoneNormalizationError>` MUST return `Ok<string>` carrying the canonical `+51XXXXXXXXX` form for all of the following input shapes. The X digits are the 9-digit mobile number starting with `9`.

#### Scenario: already E.164

- GIVEN input `"+51987654321"`
- WHEN `normalizePhoneE164("+51987654321")` is called
- THEN the result is `ok('+51987654321')`
- AND `result.ok` is `true` and `result.value` is `"+51987654321"`

#### Scenario: country prefix without plus sign

- GIVEN input `"51987654321"`
- WHEN `normalizePhoneE164("51987654321")` is called
- THEN the result is `ok('+51987654321')`

#### Scenario: bare 9-digit local mobile

- GIVEN input `"987654321"`
- WHEN `normalizePhoneE164("987654321")` is called
- THEN the result is `ok('+51987654321')`

#### Scenario: E.164 with spaces

- GIVEN input `"+51 987 654 321"`
- WHEN `normalizePhoneE164("+51 987 654 321")` is called
- THEN the result is `ok('+51987654321')`

#### Scenario: formatted with parentheses and hyphens

- GIVEN input `"(+51) 987-654-321"`
- WHEN `normalizePhoneE164("(+51) 987-654-321")` is called
- THEN the result is `ok('+51987654321')`

---

### Requirement: normalizePhoneE164 — Invalid Inputs

`normalizePhoneE164` MUST return `Err<PhoneNormalizationError>` for any input that is not a valid Peru mobile. The `error.input` MUST equal the original raw string passed in.

#### Scenario: empty string → EMPTY_INPUT

- GIVEN input `""`
- WHEN `normalizePhoneE164("")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"EMPTY_INPUT"`
- AND `result.error.input` is `""`

#### Scenario: whitespace-only string → EMPTY_INPUT

- GIVEN input `"   "`
- WHEN `normalizePhoneE164("   ")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"EMPTY_INPUT"`
- AND `result.error.input` is `"   "`

#### Scenario: too-short digit string → INVALID_FORMAT

- GIVEN input `"12345"`
- WHEN `normalizePhoneE164("12345")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`
- AND `result.error.input` is `"12345"`

#### Scenario: 8-digit local number (not a mobile, first digit not 9) → INVALID_FORMAT

- GIVEN input `"12345678"`
- WHEN `normalizePhoneE164("12345678")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`

#### Scenario: Lima landline format → INVALID_FORMAT

- GIVEN input `"014561234"` (9 digits but first digit is not 9)
- WHEN `normalizePhoneE164("014561234")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`
- AND `result.error.input` is `"014561234"`

#### Scenario: alphabetic / garbage input → INVALID_FORMAT

- GIVEN input `"abcdef"`
- WHEN `normalizePhoneE164("abcdef")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`
- AND `result.error.input` is `"abcdef"`

#### Scenario: 10 local digits (one digit too many) → INVALID_FORMAT

- GIVEN input `"9876543210"` (10 digits, no country prefix)
- WHEN `normalizePhoneE164("9876543210")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`
- AND `result.error.input` is `"9876543210"`

---

### Requirement: normalizePhoneBatch

`normalizePhoneBatch(inputs: ReadonlyArray<string>): NormalizationReport` MUST:
- Process every element in `inputs` (MUST NOT silently drop any element).
- Partition results into `valid` (normalized) and `invalid` (with error).
- Preserve the original `input` string in both buckets.
- Preserve order within each bucket (same relative order as in `inputs`).
- Return `{ valid: ReadonlyArray<NormalizedEntry>; invalid: ReadonlyArray<InvalidEntry> }`.

#### Scenario: mixed batch of valid and invalid inputs

- GIVEN inputs `["+51987654321", "abcdef", "987654321", ""]`
- WHEN `normalizePhoneBatch(["+51987654321", "abcdef", "987654321", ""])` is called
- THEN `report.valid` has 2 entries:
  - `{ input: "+51987654321", phoneE164: "+51987654321" }`
  - `{ input: "987654321", phoneE164: "+51987654321" }`
- AND `report.invalid` has 2 entries:
  - `{ input: "abcdef", error: { code: "INVALID_FORMAT", input: "abcdef" } }`
  - `{ input: "", error: { code: "EMPTY_INPUT", input: "" } }`

#### Scenario: empty array

- GIVEN inputs `[]`
- WHEN `normalizePhoneBatch([])` is called
- THEN `report.valid` is `[]`
- AND `report.invalid` is `[]`

#### Scenario: all valid batch

- GIVEN inputs `["+51987654321", "51987654321", "987654321"]`
- WHEN `normalizePhoneBatch(...)` is called
- THEN `report.valid` has 3 entries, all with `phoneE164: "+51987654321"`
- AND `report.invalid` is `[]`

#### Scenario: all invalid batch

- GIVEN inputs `["", "abc", "12345"]`
- WHEN `normalizePhoneBatch(...)` is called
- THEN `report.valid` is `[]`
- AND `report.invalid` has 3 entries with codes `["EMPTY_INPUT", "INVALID_FORMAT", "INVALID_FORMAT"]`

---

### Requirement: detectPhoneDuplicates

`detectPhoneDuplicates(phones: ReadonlyArray<string>): DedupeReport` MUST:
- Operate on **already-normalized** E.164 strings (callers are responsible for normalization).
- Group by exact string match.
- Report only groups with 2 or more members in `duplicates`.
- Report each group's `phoneE164` key and `indexes` (0-based positions in the input array).
- Report `uniqueCount` as the count of distinct `phoneE164` values in the input.
- MUST NOT merge, mutate, or remove any element.

#### Scenario: no duplicates

- GIVEN phones `["+51987654321", "+51912345678", "+51998765432"]`
- WHEN `detectPhoneDuplicates(...)` is called
- THEN `report.duplicates` is `[]`
- AND `report.uniqueCount` is `3`

#### Scenario: one duplicate pair

- GIVEN phones `["+51987654321", "+51912345678", "+51987654321"]`
- WHEN `detectPhoneDuplicates(...)` is called
- THEN `report.duplicates` has exactly 1 group:
  - `{ phoneE164: "+51987654321", indexes: [0, 2] }`
- AND `report.uniqueCount` is `2`

#### Scenario: triplicate plus a unique

- GIVEN phones `["+51987654321", "+51912345678", "+51987654321", "+51987654321"]`
- WHEN `detectPhoneDuplicates(...)` is called
- THEN `report.duplicates` has exactly 1 group:
  - `{ phoneE164: "+51987654321", indexes: [0, 2, 3] }`
- AND `report.uniqueCount` is `2`

#### Scenario: multiple duplicate groups

- GIVEN phones `["+51987654321", "+51912345678", "+51987654321", "+51912345678"]`
- WHEN `detectPhoneDuplicates(...)` is called
- THEN `report.duplicates` has 2 groups:
  - `{ phoneE164: "+51987654321", indexes: [0, 2] }`
  - `{ phoneE164: "+51912345678", indexes: [1, 3] }`
- AND `report.uniqueCount` is `2`

#### Scenario: empty array

- GIVEN phones `[]`
- WHEN `detectPhoneDuplicates([])` is called
- THEN `report.duplicates` is `[]`
- AND `report.uniqueCount` is `0`

#### Scenario: single element (cannot be a duplicate)

- GIVEN phones `["+51987654321"]`
- WHEN `detectPhoneDuplicates(["+51987654321"])` is called
- THEN `report.duplicates` is `[]`
- AND `report.uniqueCount` is `1`

---

## Out of Scope (Non-Requirements for This Slice)

- Dedupe merge / winner selection — detection only.
- Landlines — Peru mobiles only (`+51` + 9 digits, first digit `9`).
- `WRONG_COUNTRY` error code — non-Peru inputs are `INVALID_FORMAT`.
- Persistence, RLS, HTTP — pure domain.
- `contactLeadSchema.phone_e164` regex tightening — separate follow-up.
- Any alternative `Result<T, E>` shape — the shape above is final and project-wide.
