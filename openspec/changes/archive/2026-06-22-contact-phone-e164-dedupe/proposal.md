# Proposal — contact-phone-e164-dedupe

> SDD phase: propose · Project: sivi-whatsapp-hub · Artifact store: hybrid (engram topic_key `sdd/contact-phone-e164-dedupe/proposal` + this file)
> Depends on: `sdd/contact-phone-e164-dedupe/explore`

## 1. Problem statement

Corte 1 of the roadmap is "Contacts: import + dedupe by `phone_e164`". Before any of that — before HTTP, before Drizzle, before RLS — the Hub needs a **trustworthy phone identity**. `phone_e164` is the natural key for a WhatsApp contact: it is how we dedupe on import, how we match an inbound message to a known contact, and the value we hand to the CRM through the `ContactLead` contract. If that value is computed inconsistently (`987654321` vs `+51987654321` vs `+51 987 654 321` treated as three different people), every downstream feature inherits the mess: duplicate contacts, broken dedupe, mismatched conversations, wrong invoices.

This slice is intentionally the **smallest unit that exercises the full SDD + Strict TDD flow end to end**: a pure domain module — no DB, no RLS, no HTTP, no Hono — built test-first with Vitest. Two things make it foundational beyond its size:

1. **It introduces `Result<T, E>` to the codebase for the first time.** `Result` is referenced in `Docs/specs/` and mandated by CLAUDE.md ("never `throw` in domain logic"), but it has never been implemented. The shape and helper API chosen here become the canonical error-handling primitive that **every future domain module** will import. Getting this right now avoids a project-wide refactor later.
2. **It establishes the phone normalization rules** that contact import, conversation matching, and the `ContactLead` boundary will all depend on.

## 2. Scope

### In-scope (this slice)
- A local `Result<T, E>` type + `ok` / `err` constructors + type guards, at `apps/backend/src/shared/result.ts`.
- A single-value Peru-mobile E.164 normalizer (hand-rolled, zero deps).
- A batch normalizer that returns a **report**: the normalized valid numbers AND the invalid inputs with their error reason (invalid inputs are reported, never silently dropped).
- A dedupe **detector** that groups normalized numbers and flags collisions (detect only — no merge, no winner selection).
- A `PhoneNormalizationError` type with a minimal error-code set.
- Vitest tests at `apps/backend/test/contacts/phone-e164.test.ts`, written test-first (Strict TDD).

### Out-of-scope (explicitly deferred)
| Deferred item | Why deferred | Where it lands |
|---|---|---|
| **Dedupe merge / winner selection** | This slice only *detects* collisions; merging is a business-policy decision (which record wins, how to combine tags/intent) that needs its own design. | Corte 1 import flow |
| **Landlines / fixed-line numbers** | WhatsApp contacts are mobiles; landlines have different length/prefix rules. | Future, if needed |
| **`contactLeadSchema.phone_e164` regex tightening** | Touches the published boundary contract (`@sivihub/contracts`), replicated on the CRM side — out of a pure-domain slice. Flagged as follow-up (Decision F). | Follow-up change |
| **`libphonenumber-js`** | Overkill for Peru-mobile-only; tests would exercise the library, not our domain. | Future ADR if international/landline support is needed |
| **DB / Drizzle persistence** | Pure-domain slice by design. | Corte 1 |
| **RLS / `tenant_id`** | No table is touched; nothing to isolate. | Corte 1 (when contacts persist) |
| **HTTP / Hono routes** | Pure domain; no transport. | Corte 1 import endpoint |
| **`WRONG_COUNTRY` error code** | Non-Peru inputs are simply `INVALID_FORMAT` for a Peru-only normalizer; a dedicated code adds surface with no consumer. | Add when multi-country is real (Decision C) |

## 3. Proposed public API surface

All signatures use the chosen `Result<T, E>` (Decision B) and `PhoneNormalizationError` (Decision C). English, camelCase, fully typed under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.

### 3.1 `Result<T, E>` — `apps/backend/src/shared/result.ts`

```ts
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// Type guards (narrowing helpers)
export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;
```

### 3.2 Phone normalization — `apps/backend/src/contacts/phone-e164.ts`

```ts
import type { Result } from '../shared/result.js';

export type PhoneNormalizationErrorCode = 'EMPTY_INPUT' | 'INVALID_FORMAT';

export type PhoneNormalizationError = {
  readonly code: PhoneNormalizationErrorCode;
  readonly input: string;
};

/**
 * Normalizes a single raw phone string to Peru-mobile E.164 (`+51` + 9 digits starting with 9).
 * Accepts: `+51987654321`, `51987654321`, `987654321`, `+51 987 654 321`, `(+51) 987-654-321`.
 * Returns Ok with the canonical `+51XXXXXXXXX`, or Err with the reason.
 */
export const normalizePhoneE164 = (
  input: string,
): Result<string, PhoneNormalizationError> => { /* ... */ };
```

### 3.3 Batch normalization (report) — same file

```ts
export type NormalizedEntry = {
  readonly input: string;       // original raw input
  readonly phoneE164: string;   // canonical normalized value
};

export type InvalidEntry = {
  readonly input: string;
  readonly error: PhoneNormalizationError;
};

export type NormalizationReport = {
  readonly valid: ReadonlyArray<NormalizedEntry>;
  readonly invalid: ReadonlyArray<InvalidEntry>;
};

/**
 * Normalizes a batch. Invalid inputs are REPORTED (never silently dropped):
 * the report carries both the normalized valid numbers and the invalid inputs with their reason.
 * Order is preserved within each bucket.
 */
export const normalizePhoneBatch = (
  inputs: ReadonlyArray<string>,
): NormalizationReport => { /* ... */ };
```

### 3.4 Dedupe detection — `apps/backend/src/contacts/contact-dedupe.ts`

```ts
export type DuplicateGroup = {
  readonly phoneE164: string;            // the normalized key the collision is keyed on
  readonly indexes: ReadonlyArray<number>; // positions in the input array that collide (length >= 2)
};

export type DedupeReport = {
  readonly duplicates: ReadonlyArray<DuplicateGroup>; // only groups with >= 2 members
  readonly uniqueCount: number;                       // distinct phoneE164 values seen
};

/**
 * DETECTS duplicates only. Groups already-normalized E.164 values by exact match
 * and flags every key seen 2+ times. Does NOT merge records, pick a winner, or mutate input.
 */
export const detectPhoneDuplicates = (
  phones: ReadonlyArray<string>,
): DedupeReport => { /* ... */ };
```

> Note: `detectPhoneDuplicates` operates on **already-normalized** values. Callers normalize first (via `normalizePhoneE164` / `normalizePhoneBatch`), then detect. This keeps each function single-responsibility and trivially testable. The contact-import composition (normalize → detect) belongs to Corte 1, not this slice.

## 4. Delegated decisions A–F

### A. `Result<T, E>` placement → **local: `apps/backend/src/shared/result.ts`**
Zero new packages; smallest footprint for an evaluation slice. `Result` is consumed only by backend domain code right now; nothing in `packages/contracts` needs it yet. **Rationale:** YAGNI — do not stand up a `packages/core` workspace for one slice. **Flagged debt:** if `packages/contracts` or a future package needs `Result`, promote `shared/result.ts` to `@sivihub/core` (mechanical move; the shape/API below is designed to survive that move unchanged).

### B. `Result<T, E>` shape → **discriminated union on `ok: boolean`, with `value` / `error` payloads** (THE canonical project decision)
```ts
type Ok<T>  = { readonly ok: true;  readonly value: T };
type Err<E> = { readonly ok: false; readonly error: E };
type Result<T, E> = Ok<T> | Err<E>;
const ok  = <T>(value: T) => ({ ok: true,  value }) as Ok<T>;
const err = <E>(error: E) => ({ ok: false, error }) as Err<E>;
const isOk  = <T, E>(r: Result<T, E>): r is Ok<T>  => r.ok;
const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;
```
**Rationale — why `ok: boolean` over `type: 'ok' | 'err'`:**
- **Best ergonomics under TS `strict`:** `if (result.ok)` narrows the union to `Ok<T>` in one boolean check — no string comparison, no typos in a literal discriminant. The compiler exposes `.value` / `.error` only on the correct branch.
- **`readonly` everywhere** matches the codebase's immutability bias and `exactOptionalPropertyTypes`.
- **`value` / `error` named fields** read clearly at call sites (`result.value`, `result.error`) and are conventional in the TS Result ecosystem (neverthrow, fp-ts `Either`-adjacent).
- **Boolean discriminant is cheaper and less error-prone** than a string tag for a binary outcome; there is no third state to model.
- **Decision is final and project-wide:** every future domain module imports this exact `Result`, `ok`, `err`, `isOk`, `isErr`. No alternative Result shape is permitted.

### C. Error model → **minimal: `EMPTY_INPUT` + `INVALID_FORMAT`; `WRONG_COUNTRY` deferred**
```ts
type PhoneNormalizationErrorCode = 'EMPTY_INPUT' | 'INVALID_FORMAT';
type PhoneNormalizationError = { readonly code: PhoneNormalizationErrorCode; readonly input: string };
```
- `EMPTY_INPUT` — empty / whitespace-only input (distinct because the UI/import surface a different message for "you gave us nothing").
- `INVALID_FORMAT` — anything that is not a Peru mobile (`+51` + 9 digits starting with `9`): wrong length, wrong prefix, non-Peru country code, letters, etc.
- **`WRONG_COUNTRY` deferred:** for a Peru-only normalizer a non-Peru number is indistinguishable in value from any other malformed input — it is just `INVALID_FORMAT`. Adding the code now creates surface with no consumer and would imply multi-country logic we are explicitly not building. Add it when multi-country import is a real requirement.
- `input` carries the **original raw string** so the batch report and any future UI can echo exactly what the user submitted.

### D. Normalizer implementation → **hand-rolled, Peru-scoped, zero deps** (confirmed)
Algorithm: trim → strip all non-digit characters → if it starts with `51` and has 11 digits, drop the `51` → require exactly 9 remaining digits with the first digit `9` → emit `+51` + those 9 digits; otherwise `err(INVALID_FORMAT)` (or `EMPTY_INPUT` if blank). **Rationale:** all logic stays under our tests (the whole point of Strict TDD); explicit Peru rules; no ~25KB dependency for a Peru-mobile-only MVP. `libphonenumber-js` is deferred to a future ADR if/when international or landline support is needed.

### E. Test location → **`apps/backend/test/contacts/phone-e164.test.ts`** (mirror existing `test/` convention)
The only existing test lives at `apps/backend/test/health.test.ts` (a `test/` dir separate from `src/`). Mirroring it keeps `src/` clean and stays consistent. Backend has no explicit vitest `include`, so defaults discover `**/*.test.ts` — both locations work, but consistency wins. Imports follow NodeNext: `import { describe, expect, it } from 'vitest'` and internal imports use the `.js` extension. A sibling `contact-dedupe.test.ts` (or a shared file) covers dedupe detection.

### F. `contactLeadSchema.phone_e164` regex tightening → **DEFER (flagged follow-up)**
`packages/contracts/src/contact-lead.ts` declares `phone_e164: z.string()` with no refinement. Tightening to `z.string().regex(/^\+51\d{9}$/)` is desirable but **out of this pure-domain slice** — it changes the published Hub→CRM boundary contract (replicated on the CRM side, per the file's own comment) and would need cross-repo coordination. **Follow-up:** once this normalizer is the single producer of `phone_e164`, add the regex refinement to `contactLeadSchema` in a dedicated change so the contract enforces what the normalizer guarantees.

## 5. Non-goals / first-slice boundaries
- No merging, deduping-to-a-winner, or record mutation — **detection only**.
- No landline support — **Peru mobiles only** (`+51` + 9 digits, first digit `9`).
- No persistence, no RLS, no `tenant_id`, no HTTP, no Hono — **pure domain**.
- No new workspace package — `Result` stays local to the backend.
- No phone library — hand-rolled.
- No change to `@sivihub/contracts` — the schema regex is a separate follow-up.
- The Result shape decided here is **final and project-wide**; this slice is not a place to experiment with alternative error monads.

## 6. Risks
1. **`Result<T, E>` is a project-wide commitment.** Every future domain module inherits this shape. Mitigation: the chosen `ok: boolean` discriminated union is the conventional, ergonomically-strongest TS form; type guards and `readonly` fields are designed to survive a future move to `@sivihub/core` unchanged.
2. **Local `Result` placement = mild tech debt.** If `packages/contracts` later needs `Result`, it must be extracted. Mitigation: mechanical move; documented in Decision A.
3. **`contactLeadSchema` has no E.164 validation after this slice.** A malformed `phone_e164` could still reach the CRM contract until the follow-up regex lands. Mitigation: flagged as the immediate next follow-up (Decision F); low risk while no import path is wired yet.
4. **Test discovery relies on vitest defaults** (no explicit backend `include`). Mitigation: low risk now; if a package-level config with explicit `include` is added later, test paths may need to align — note in Corte 1.
5. **Hand-rolled normalizer is Peru-mobile-only by design.** International or landline inputs all collapse to `INVALID_FORMAT`. Accepted for this slice; revisit via ADR when scope expands (Decision D).

## 7. Next recommended
`sdd-spec` and `sdd-design` (can run in parallel). Spec turns the API surface + normalization rules into testable acceptance criteria; design pins the `Result` primitive, module layout, and the normalize→detect composition boundary.
