# Design — contact-phone-e164-dedupe

> SDD phase: design · Project: sivi-whatsapp-hub · Artifact store: hybrid (engram `sdd/contact-phone-e164-dedupe/design` + this file)
> Depends on: `sdd/contact-phone-e164-dedupe/proposal`

## Technical Approach

Pure-domain slice, zero runtime deps, zero I/O. Two source files plus one Vitest file, built test-first under Strict TDD. `result.ts` is the foundational, dependency-free primitive; `phone-e164.ts` imports it and holds the normalizer, batch report, and dedupe detector. No `Date`, no randomness, no DB/HTTP/Hono — every output is a deterministic function of its input. All decisions (Result shape, hand-rolled normalizer, error model, file locations) are FIXED by the proposal; this design only pins the HOW.

> Deviation from proposal §3.4: the proposal sketched a separate `contact-dedupe.ts`. This design consolidates `detectPhoneDuplicates` + dedupe types INTO `phone-e164.ts` (3-file layout per task scope). Same single-responsibility functions, fewer files for a tiny slice. The split into `contact-dedupe.ts` is a mechanical follow-up if the file grows.

## File Layout

| File | Action | Contents |
|------|--------|----------|
| `apps/backend/src/shared/result.ts` | Create | `Ok<T>`, `Err<E>`, `Result<T,E>`, `ok`, `err`, `isOk`, `isErr`. No imports. |
| `apps/backend/src/contacts/phone-e164.ts` | Create | Error types + `normalizePhoneE164` + report types + `normalizePhoneBatch` + dedupe types + `detectPhoneDuplicates`. |
| `apps/backend/test/contacts/phone-e164.test.ts` | Create | Vitest suite, `describe` per function, table-driven. Written failing FIRST. |

**Import paths under NodeNext (`.js` suffix on internal imports):**
- In `phone-e164.ts`: `import { ok, err, type Result } from '../shared/result.js';` (src/contacts → src/shared).
- In the test: `import { isOk, isErr } from '../../src/shared/result.js';` and `import { normalizePhoneE164, normalizePhoneBatch, detectPhoneDuplicates, type PhoneNormalizationError } from '../../src/contacts/phone-e164.js';` (test/contacts → src/...).
- `import { describe, expect, it } from 'vitest';` (mirrors `test/health.test.ts`).

## Architecture Decisions

### Decision: `result.ts` has zero imports and zero domain coupling
**Choice**: Standalone primitive file consumed by `phone-e164.ts`.
**Alternatives considered**: Co-locate Result inside `phone-e164.ts`; stand up `@sivihub/core`.
**Rationale**: Result is project-wide (proposal Decision A/B). Keeping it import-free makes the future mechanical move to `@sivihub/core` trivial and lets every domain module import the exact same shape.

### Decision: `ok`/`err` typed return WITHOUT `as` assertions
**Choice**: `const ok = <T>(value: T): Ok<T> => ({ ok: true, value });` — explicit return type, no cast.
**Alternatives considered**: `=> ({ ok: true, value }) as Ok<T>` (proposal sketch).
**Rationale**: The object literal `{ ok: true, value }` already widens `ok` to `boolean` without an annotation; the explicit `: Ok<T>` return type forces the literal `true` and avoids an `as` cast. Cleaner under `strict` and friendlier to Biome.

### Decision: empty-check ordering — trim BEFORE strip
**Choice**: Distinguish `EMPTY_INPUT` from `INVALID_FORMAT` by checking `input.trim() === ''` FIRST, before digit stripping.
**Alternatives considered**: Check digits-empty after stripping (would misclassify `"abc"` as EMPTY).
**Rationale**: "You gave us nothing" (`""`, `"   "`) is a distinct UX message from "what you gave is not a Peru mobile" (`"abc"`, `"123"`). `"abc"` trims to `"abc"` (non-empty) → strips to `""` → must be `INVALID_FORMAT`, NOT `EMPTY_INPUT`.

### Decision: `error.input` echoes the ORIGINAL raw string
**Choice**: `PhoneNormalizationError.input` carries the untrimmed, unstripped original argument.
**Rationale**: Proposal Decision C — the report/UI echoes exactly what the user submitted.

## Normalizer Algorithm (`normalizePhoneE164`) — step by step

Input: `string`. Output: `Result<string, PhoneNormalizationError>`. `raw` = the original argument (echoed in errors).

1. **Empty check (first):** if `raw.trim() === ''` → `err({ code: 'EMPTY_INPUT', input: raw })`. STOP.
2. **Strip:** `digits = raw.replace(/\D/g, '')` (remove every non-digit, including `+`, spaces, `(`, `)`, `-`).
3. **Drop country code:** if `digits.length === 11 && digits.startsWith('51')` → `digits = digits.slice(2)`.
4. **Validate mobile:** require `digits.length === 9 && digits.startsWith('9')`. Use `/^9\d{8}$/.test(digits)`. If it fails → `err({ code: 'INVALID_FORMAT', input: raw })`. STOP.
5. **Emit:** `ok('+51' + digits)` → canonical `+51XXXXXXXXX`.

**Distinguishing the two error codes:** `EMPTY_INPUT` is reachable ONLY via step 1 (trimmed-empty original). Every other rejection — wrong length, missing/extra `51`, non-`9` first digit, letters that strip to non-mobile, non-Peru country code — is `INVALID_FORMAT`. There is no third path.

**Worked cases:**
- `"+51 987 654 321"` → strip `51987654321` (11, starts `51`) → slice → `987654321` (9, starts `9`) → `+51987654321`. ✓
- `"987654321"` → strip `987654321` (9, starts `9`) → `+51987654321`. ✓
- `"51987654321"` → 11/`51` → `987654321` → `+51987654321`. ✓
- `"(+51) 987-654-321"` → strip `51987654321` → `+51987654321`. ✓
- `""` / `"   "` → `EMPTY_INPUT`. `"abc"` → strips `""` → length 0 ≠ 9 → `INVALID_FORMAT`.
- `"123456789"` (9 digits, starts `1`) → `INVALID_FORMAT`. `"5198765432"` (10) → `INVALID_FORMAT`. `"+1 555 0100"` → strips `15550100` → not 9/`9` → `INVALID_FORMAT`.

## Dedupe Algorithm (`detectPhoneDuplicates`) — step by step

Input: `ReadonlyArray<string>` of ALREADY-normalized values. Output: `DedupeReport`. Pure, no normalization performed here.

1. **Group preserving first-seen order:** iterate `phones` with index `i`. Maintain a `Map<string, number[]>` keyed by phone value, pushing `i` to each value's index list. Maintain a separate `string[]` `order` of distinct keys in first-encounter order (so report ordering is deterministic and input-driven, independent of `Map` insertion quirks — though `Map` preserves insertion order, the explicit `order` array documents intent).
2. **`noUncheckedIndexedAccess` handling:** every `map.get(key)` returns `number[] | undefined`. Guard each read: `const existing = map.get(value); if (existing === undefined) { map.set(value, [i]); order.push(value); } else { existing.push(i); }`. NEVER index a possibly-undefined array without a guard.
3. **Collect duplicates:** for each key in `order`, read its index list (guard the `.get` again or reuse the reference), and if `list.length >= 2` push `{ phoneE164: key, indexes: list }` to `duplicates`. Singletons are skipped.
4. **`uniqueCount`:** `order.length` — the number of DISTINCT `phoneE164` values seen (NOT the count of non-duplicated values). E.g. `['+51999','+51999','+51888']` → `uniqueCount = 2`, `duplicates = [{ phoneE164: '+51999', indexes: [0,1] }]`.

**Ordering / determinism:**
- `indexes` within a group are ascending (push order = iteration order).
- `duplicates` groups are ordered by FIRST occurrence of each colliding key (driven by `order`), so the report is stable and input-driven.
- No `Date`, no `Math.random`, no I/O. Same input → byte-identical output.

## Interfaces / Contracts (exact TypeScript)

### `apps/backend/src/shared/result.ts`
```ts
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;
```

### `apps/backend/src/contacts/phone-e164.ts` (types)
```ts
import { err, ok, type Result } from '../shared/result.js';

export type PhoneNormalizationErrorCode = 'EMPTY_INPUT' | 'INVALID_FORMAT';

export type PhoneNormalizationError = {
  readonly code: PhoneNormalizationErrorCode;
  readonly input: string; // original raw input, echoed for UI/report
};

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
  readonly indexes: ReadonlyArray<number>; // length >= 2, ascending
};
export type DedupeReport = {
  readonly duplicates: ReadonlyArray<DuplicateGroup>;
  readonly uniqueCount: number; // distinct phoneE164 values
};
```
`normalizePhoneBatch` builds mutable `NormalizedEntry[]` / `InvalidEntry[]`, calls `normalizePhoneE164` per input, routes via `isOk`/`isErr`, preserves input order in each bucket, returns the two arrays widened to `ReadonlyArray`.

## Testing Strategy

| Layer | What to test | Approach |
|-------|--------------|----------|
| Unit | `normalizePhoneE164` | Table-driven `it.each`: valid forms → `+51987654321`; `''`/`'   '` → `EMPTY_INPUT`; malformed → `INVALID_FORMAT`. Assert via `isOk`/`isErr` then `.value`/`.error.code` and `.error.input` echo. |
| Unit | `normalizePhoneBatch` | Mixed input array → assert `valid`/`invalid` buckets, order preserved, invalid carries reason + original input. |
| Unit | `detectPhoneDuplicates` | No dups → empty `duplicates`, `uniqueCount === n`; dups → correct groups, ascending `indexes`, group order = first-occurrence; `uniqueCount` = distinct count. |
| Unit | `result.ts` (light) | Exercised transitively through the above; optional direct `ok`/`err`/`isOk`/`isErr` narrowing checks. |

**Structure:** one top-level `describe('phone-e164', ...)` with nested `describe` per function. Use `it.each` for the normalizer/dedupe tables. **Strict TDD:** write the full failing suite FIRST (red), run the configured test command to confirm failures, then implement `result.ts` then `phone-e164.ts` until green. No production code before a failing test that demands it.

## Migration / Rollout
No migration. No data, no schema, no flags. New files only; nothing existing is touched.

## Open Questions
None. All decisions resolved in the proposal (A–F).
