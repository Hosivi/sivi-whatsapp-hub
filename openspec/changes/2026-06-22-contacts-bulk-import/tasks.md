# Tasks: contacts-bulk-import

> Change: contacts-bulk-import · Project: sivi-whatsapp-hub
> Artifact store: hybrid
> Strict TDD: ACTIVE — every implementation task is preceded by a RED (failing test) task.
> Canonical contract source: orchestrator reconciliation note (6 outcomes, `index` field, `input` echo, `errors` in invariant).

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~380–430 (4 files: new service ~100, route delta ~50, unit test ~130, int test ~150) |
| 400-line budget risk | Medium-High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: types + service + unit test (foundation, Docker-free CI) → PR 2: route wiring + integration test (real DB) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Types + pure service + unit test (Docker-free) | PR 1 | Standalone; CI passes without DB |
| 2 | Route handler + Zod schema + integration test + artifact reconciliation | PR 2 | Depends on PR 1; requires Testcontainers |

---

## Phase 1: Artifact Reconciliation (precondition — do first)

- [x] 1.1 **Update `spec.md`** — add `error` as the 6th `RowOutcome` entry in the RowOutcome Enum table; add `errors: number` to the summary response shape; update the Summary Counts invariant to `imported + resurrected + skippedInvalidPhone + skippedDuplicateInBatch + skippedAlreadyExists + errors === total`. File: `openspec/changes/2026-06-22-contacts-bulk-import/spec.md`.
- [x] 1.2 **Update `design.md`** — change all `rowIndex` references in the `RowOutcome` type block (§6) to `index`; add `readonly input: ImportRow` to each `RowOutcome` variant; verify the data-flow diagram (§10) uses `index` not `rowIndex`. File: `openspec/changes/2026-06-22-contacts-bulk-import/design.md`.

---

## Phase 2: Foundation — Types (RED before GREEN)

- [x] 2.1 **RED** — In `contacts.import.test.ts` (NEW, Docker-free unit test), write a compile-only import of `ImportRow`, `RowOutcome`, `ImportSummary`, `ImportReport` from `./contacts.import.js`. Vitest run MUST fail with "Cannot find module". File: `apps/backend/test/contacts/contacts.import.test.ts`.
- [x] 2.2 **GREEN** — Create `apps/backend/src/contacts/contacts.import.ts` with the canonical types:
  - `ImportRow = NewContactInput` (alias, no new fields).
  - `RowOutcome` — 6 variants, each with `index: number` (NOT `rowIndex`) and `input: ImportRow` plus variant-specific fields (`contactId`, `reason`, `canonicalRowIndex`, `code`).
  - `ImportSummary` — 7 fields: `total`, `imported`, `resurrected`, `skippedInvalidPhone`, `skippedDuplicateInBatch`, `skippedAlreadyExists`, `errors`.
  - `ImportReport = { summary: ImportSummary; rows: ReadonlyArray<RowOutcome> }`.
  - Export stub `importContacts` (returns `Promise<ImportReport>`; body `throw new Error('not implemented')`).
  - Confirm compile-only test now passes type-check.

---

## Phase 3: Pure Service — Unit Test (RED) then Implementation (GREEN)

- [x] 3.1 **RED** — In `contacts.import.test.ts`, implement a FAKE in-memory repo matching `ContactsRepository`:
  - Holds `Map<phoneE164, 'live' | 'softDeleted'>` seeded per test.
  - `create(input)`: re-normalizes via `normalizePhoneE164`; returns `err(INVALID_PHONE)` for bad phone; `err(CONTACT_ALREADY_EXISTS)` for live; `ok(Contact)` with `createdAt === updatedAt` for absent; `ok(Contact)` with `createdAt < updatedAt` for soft-deleted; `err(DB_ERROR)` for a configurable "poison phone".
  - Write all 7 unit cases as failing tests (each calling `importContacts` which still throws):
    1. All-new rows → all `imported`, `summary.imported === n`, order preserved, each row has `index` and `input` echoed.
    2. Empty phone (whitespace) → `skipped-invalid-phone` with `reason: 'EMPTY_INPUT'`; malformed → `reason: 'INVALID_FORMAT'`; surrounding valid rows still `imported`.
    3. Within-batch duplicate → first `imported`, second `skipped-duplicate-in-batch` with `canonicalRowIndex: 0`; fake `create` called exactly ONCE for that phone.
    4. Live phone in DB → `skipped-already-exists`; `summary.skippedAlreadyExists === 1`.
    5. Soft-deleted phone → `resurrected` with `contactId`; `summary.resurrected === 1`.
    6. DB_ERROR phone → row `status: 'error'` with `code: 'DB_ERROR'`; `summary.errors === 1`; remaining rows still processed (processing does NOT abort).
    7. Mixed batch (all 6 outcomes in one call) → full `summary` tally adds up to `total`; `rows` array preserves original index order; each row echoes `input`.
  - All 7 tests MUST be RED (failing) at this point.
- [x] 3.2 **GREEN** — Implement `importContacts` in `contacts.import.ts`:
  - Running `Set<string>` + `Map<string, number>` for in-batch dedup (NOT `detectPhoneDuplicates`).
  - Per-row pipeline (§5 of design): normalize → dedup → `repo.create` → map result.
  - `resurrected` detection: `contact.createdAt.getTime() < contact.updatedAt.getTime()`.
  - Each `RowOutcome` includes `index` (original 0-based position) and `input` (the submitted row object).
  - Summary tallied from `rows` AFTER the loop (single source of truth).
  - NEVER throws; all per-row errors are data.
  - All 7 unit tests MUST be GREEN.
- [x] 3.3 **REFACTOR** — Verify no `rowIndex` references remain in `contacts.import.ts`; confirm `errors` is always included in `ImportSummary` (even when 0); run `pnpm test` for the unit test file only to confirm GREEN.

---

## Phase 4: Route Wiring — Integration Test (RED) then Implementation (GREEN)

- [x] 4.1 **RED** — Create `apps/backend/test/contacts/contacts.import.int.test.ts` (Testcontainers, `app_rls` role, through `buildApp`). One shared container via `beforeAll`/`afterAll`; `beforeEach` truncates. Write all 7 integration test cases as failing (route returns 404 for unknown path):
  1. Happy path: 3 valid new rows → 200, `summary.imported === 3`, each `rows[i]` has `index`, `input`, `outcome: 'imported'`, a real UUID `contactId`.
  2. Within-batch duplicate: same phone twice → 200, first `imported`, second `skipped-duplicate-in-batch` (`canonicalRowIndex: 0`), DB has ONE contact row.
  3. Invalid Peru mobile in batch → 200 (NOT 400), that row `skipped-invalid-phone`.
  4. Already-live phone → `skipped-already-exists`; existing contact row unchanged.
  5. **RESURRECT** (non-optional regression guard): create via `POST /contacts`, soft-delete via `DELETE /contacts/:id`, then `POST /contacts/import` with same phone → `resurrected`, `contactId` equals original `id`, `deletedAt` cleared in DB (assert via `adminQuery`).
  6. Batch validation: `contacts: []` → 400 `VALIDATION_ERROR`; 201-element array → 400; malformed body → 400.
  7. **TENANT ISOLATION**: import phone under TENANT_A; `GET /contacts` as TENANT_B → phone absent; import same phone under TENANT_B → `imported` (not `skipped-already-exists`), confirming RLS scoping through bulk path.
  - All 7 tests MUST be RED.
- [x] 4.2 **GREEN** — In `contacts.route.ts` (MODIFIED), add inline:
  - `const importRowSchema = createBodySchema;` (alias, zero drift).
  - `const importBodySchema = z.object({ contacts: z.array(importRowSchema).min(1).max(200) });`.
  - `router.post('/import', ...)` handler BEFORE any `/:id` dynamic handler to avoid Hono path collision (static path wins; confirm route ordering): parse JSON (catch → 400), `safeParse` (fail → 400), build repo from `c.get('tenantId')`, call `importContacts(repo, parsed.data.contacts)`, return `c.json(report, report.summary.errors > 0 ? 500 : 200)`.
  - Add `import { importContacts } from './contacts.import.js';` at top.
  - All 7 integration tests MUST be GREEN.
- [x] 4.3 **REFACTOR** — Confirm `POST /` (single-create) still returns 201 (no regression); confirm `GET /`, `PATCH /:id`, `DELETE /:id` unaffected; run full `pnpm test` suite GREEN.

---

## Phase 5: Final Verification

- [x] 5.1 Run `pnpm test` from repo root — all suites GREEN (unit + integration).
- [x] 5.2 Confirm the 6-bucket summary invariant in the mixed-batch test: `imported + resurrected + skippedInvalidPhone + skippedDuplicateInBatch + skippedAlreadyExists + errors === total`.
- [x] 5.3 Confirm `RowOutcome` in the response body uses `index` (NOT `rowIndex`) and echoes `input` in every row — spot-check via the integration happy-path response body.
- [x] 5.4 Confirm the resurrect integration test asserts `contactId` equality with the original `id` (same DB row, not a new one) — this is the NON-OPTIONAL regression guard for ADR-001.
