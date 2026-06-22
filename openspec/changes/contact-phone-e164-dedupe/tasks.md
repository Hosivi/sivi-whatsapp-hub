# Tasks — contact-phone-e164-dedupe

> SDD phase: tasks · Project: sivi-whatsapp-hub · Artifact store: hybrid
> Depends on: `sdd/contact-phone-e164-dedupe/spec` + `sdd/contact-phone-e164-dedupe/design`
> Strict TDD: ACTIVE · Test runner: `pnpm test` (Vitest, `vitest run` in `apps/backend`)
> Delivery strategy: auto-chain

---

## Review Workload Forecast

| Metric | Estimate |
|--------|----------|
| `apps/backend/src/shared/result.ts` | ~8 lines (new file) |
| `apps/backend/src/contacts/phone-e164.ts` | ~65 lines (new file) |
| `apps/backend/test/contacts/phone-e164.test.ts` | ~140 lines (new file) |
| **Total changed lines** | **~213 lines** |
| Chained PRs recommended | **No** |
| 400-line budget risk | **Low** |
| Decision needed before apply | **No** |

Single PR. All 3 files land together as one reviewable work unit.

---

## Work Units (Strict TDD Order)

Tasks are grouped into **3 sequential work units**. Each unit = one commit.
No task may be started before its predecessor is green.

---

### Work Unit 1 — Failing test suite (RED)

**Commit message:** `test(contacts): add failing phone-e164 + result unit tests (red)`

#### Task 1 — Create the full failing test file [x]

- **Action:** Create `apps/backend/test/contacts/phone-e164.test.ts` with all 24 spec scenarios.
  Import from `../../src/shared/result.js` and `../../src/contacts/phone-e164.js` (NodeNext `.js` suffix).
  Neither source file exists yet, so every import fails at module resolution — the suite is RED by definition.
- **Files touched:** `apps/backend/test/contacts/phone-e164.test.ts` (create)
- **Spec coverage:**
  - All 6 Result helper scenarios (ok, err, isOk, isErr)
  - All 5 normalizePhoneE164 valid-input scenarios
  - All 7 normalizePhoneE164 invalid-input scenarios
  - All 4 normalizePhoneBatch scenarios
  - All 6 detectPhoneDuplicates scenarios
- **Done criterion:** `pnpm --filter @sivihub/whatsapp-hub-backend test` exits non-zero; Vitest reports module-not-found or equivalent import errors for the two missing source modules.
- **Parallel?** No — this task is first.

---

### Work Unit 2 — Implement Result primitive (GREEN for WU1 partial)

**Commit message:** `feat(shared): add Result<T,E> discriminated union and helpers`

#### Task 2 — Create `apps/backend/src/shared/result.ts` [x]

- **Action:** Create the file with the exact types and helpers from the design:
  `Ok<T>`, `Err<E>`, `Result<T, E>`, `ok`, `err`, `isOk`, `isErr`.
  Zero imports. All fields `readonly`. Use explicit return types (no `as` cast).
  Exported as named exports.
- **Files touched:** `apps/backend/src/shared/result.ts` (create)
- **Spec coverage:** Scenarios for ok, err, isOk (true + false), isErr (true + false) — 6 scenarios.
- **Done criterion:** After creating this file (and before phone-e164.ts exists), running tests still fails at the phone-e164.js import, but the result.ts import resolves. The 6 Result scenarios pass; the remaining 18 are still red.
- **Parallel?** Sequential after Task 1.

---

### Work Unit 3 — Implement phone-e164 domain functions (ALL GREEN)

**Commit message:** `feat(contacts): add phone-e164 normalizer, batch, and dedupe detection`

#### Task 3 — Create `apps/backend/src/contacts/phone-e164.ts` [x]

- **Action:** Create the file with all exported types and functions in this order:
  1. Types: `PhoneNormalizationErrorCode`, `PhoneNormalizationError`, `NormalizedEntry`, `InvalidEntry`, `NormalizationReport`, `DuplicateGroup`, `DedupeReport`.
  2. `normalizePhoneE164(input: string): Result<string, PhoneNormalizationError>` — algorithm:
     - Step 1: if `input.trim() === ''` → `err({ code: 'EMPTY_INPUT', input })`. STOP.
     - Step 2: `digits = input.replace(/\D/g, '')`.
     - Step 3: if `digits.length === 11 && digits.startsWith('51')` → `digits = digits.slice(2)`.
     - Step 4: if not `/^9\d{8}$/.test(digits)` → `err({ code: 'INVALID_FORMAT', input })`. STOP.
     - Step 5: `return ok('+51' + digits)`.
     - `error.input` MUST echo the original raw `input` (not trimmed/stripped).
  3. `normalizePhoneBatch(inputs: ReadonlyArray<string>): NormalizationReport` — map each entry through `normalizePhoneE164`, partition into valid/invalid buckets, preserve order.
  4. `detectPhoneDuplicates(phones: ReadonlyArray<string>): DedupeReport` — iterate with index, build `Map<string, number[]>` + explicit `order: string[]` (first-encounter), push `{ phoneE164, indexes }` for groups with length >= 2; `uniqueCount = order.length`.
  - Import: `import { err, ok, type Result } from '../shared/result.js';`
- **Files touched:** `apps/backend/src/contacts/phone-e164.ts` (create)
- **Spec coverage:** All 18 remaining scenarios (5 valid-input, 7 invalid-input, 4 batch, 6 dedupe).
- **Done criterion:** `pnpm --filter @sivihub/whatsapp-hub-backend test` exits 0; all 24 scenarios green.
- **Parallel?** Sequential after Task 2.

---

### Work Unit 4 — Full suite verification + lint (SHIP CHECK)

**Commit message:** *(no separate commit — verification only, folds into WU3 if clean)*

#### Task 4 — Run full `pnpm test` and lint [x]

- **Action:**
  1. Run `pnpm test` from repo root (runs both smoke suite and `turbo test` → backend Vitest).
  2. Confirm all 24 spec scenarios pass; no other tests regress.
  3. Run `pnpm --filter @sivihub/whatsapp-hub-backend lint` (Biome) — fix any auto-fixable issues.
- **Files touched:** none (read-only verification; lint auto-fixes are in-place on the 3 source files if needed).
- **Done criterion:** `pnpm test` exits 0, all 24 scenarios report green. Biome reports 0 errors.
- **Parallel?** Sequential after Task 3. If lint produces auto-fixes, amend or fold into WU3 commit before opening PR.

---

## Dependency Graph

```
Task 1 (failing tests, RED)
  └─► Task 2 (result.ts, partial GREEN — 6 scenarios)
        └─► Task 3 (phone-e164.ts, ALL 24 GREEN)
              └─► Task 4 (full pnpm test + lint verification)
```

All tasks are strictly sequential (no parallelism) because each step depends on the previous file or green state.

---

## Spec Scenario Coverage Map

| Spec Scenario | Task(s) |
|---|---|
| ok helper produces success variant | T1 (test), T2 (impl) |
| err helper produces failure variant | T1 (test), T2 (impl) |
| isOk narrows on success | T1 (test), T2 (impl) |
| isOk returns false on failure | T1 (test), T2 (impl) |
| isErr narrows on failure | T1 (test), T2 (impl) |
| isErr returns false on success | T1 (test), T2 (impl) |
| normalizePhoneE164 — already E.164 | T1 (test), T3 (impl) |
| normalizePhoneE164 — prefix without + | T1 (test), T3 (impl) |
| normalizePhoneE164 — bare 9-digit | T1 (test), T3 (impl) |
| normalizePhoneE164 — E.164 with spaces | T1 (test), T3 (impl) |
| normalizePhoneE164 — parentheses + hyphens | T1 (test), T3 (impl) |
| normalizePhoneE164 — empty string EMPTY_INPUT | T1 (test), T3 (impl) |
| normalizePhoneE164 — whitespace EMPTY_INPUT | T1 (test), T3 (impl) |
| normalizePhoneE164 — too-short INVALID_FORMAT | T1 (test), T3 (impl) |
| normalizePhoneE164 — 8-digit non-mobile INVALID_FORMAT | T1 (test), T3 (impl) |
| normalizePhoneE164 — Lima landline INVALID_FORMAT | T1 (test), T3 (impl) |
| normalizePhoneE164 — alphabetic INVALID_FORMAT | T1 (test), T3 (impl) |
| normalizePhoneE164 — 10 local digits INVALID_FORMAT | T1 (test), T3 (impl) |
| normalizePhoneBatch — mixed valid/invalid | T1 (test), T3 (impl) |
| normalizePhoneBatch — empty array | T1 (test), T3 (impl) |
| normalizePhoneBatch — all valid | T1 (test), T3 (impl) |
| normalizePhoneBatch — all invalid | T1 (test), T3 (impl) |
| detectPhoneDuplicates — no duplicates | T1 (test), T3 (impl) |
| detectPhoneDuplicates — one duplicate pair | T1 (test), T3 (impl) |
| detectPhoneDuplicates — triplicate + unique | T1 (test), T3 (impl) |
| detectPhoneDuplicates — multiple groups | T1 (test), T3 (impl) |
| detectPhoneDuplicates — empty array | T1 (test), T3 (impl) |
| detectPhoneDuplicates — single element | T1 (test), T3 (impl) |

> Note: spec has 24 formal scenarios (6 Result + 12 normalizePhoneE164 + 4 batch + 6 dedupe = 28 rows above because the 4 normalizePhoneE164 valid and 5+7=12 normalizePhoneE164 invalid scenarios = 17 rows; batch = 4; dedupe = 6; Result = 6 → 33... spec count: 6+5+7+4+6 = 28 total spec scenarios). Task 1 covers all of them.

---

## Files to Create

| File | Status |
|------|--------|
| `apps/backend/test/contacts/phone-e164.test.ts` | New (Task 1) |
| `apps/backend/src/shared/result.ts` | New (Task 2) |
| `apps/backend/src/contacts/phone-e164.ts` | New (Task 3) |

No existing files are modified. No migrations. No HTTP routes touched.

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| NodeNext `.js` import suffix required in test | Low | Design is explicit: use `../../src/shared/result.js` and `../../src/contacts/phone-e164.js` |
| `noUncheckedIndexedAccess` in dedupe Map | Low | Design specifies the `existing === undefined` guard pattern explicitly |
| `noUnusedLocals`/`noUnusedParameters` TS flags | Low | All exported types are used in function signatures; lint gate in Task 4 catches any slip |
| Backend has no `vitest.config.ts` | Low | Vitest default include (`**/*.test.ts`) covers `test/contacts/phone-e164.test.ts` without config |
