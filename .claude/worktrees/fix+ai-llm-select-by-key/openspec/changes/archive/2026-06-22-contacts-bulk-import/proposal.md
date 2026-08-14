# Proposal — contacts-bulk-import

> SDD phase: propose · Project: sivi-whatsapp-hub · Artifact store: hybrid (engram topic_key `sdd/contacts-bulk-import/proposal` + this file)
> Depends on: `sdd/contacts-bulk-import/explore`

## 1. Problem statement

Corte 1 is "Contacts: import + dedupe by `phone_e164`". Single-contact `POST /contacts` already exists, but a Peruvian MYPE onboarding the Hub has its customer base in a spreadsheet, address book, or another tool — dozens to hundreds of numbers at once. Forcing one HTTP call per contact is operationally hopeless and pushes dedupe (the same person typed three different ways) back onto the user. The Hub needs a single endpoint that ingests many rows, normalizes each phone to the canonical E.164 identity, de-duplicates **within the batch** and **against existing contacts**, and returns a row-by-row report so the operator knows exactly what landed, what was skipped, and why.

This slice deliberately **composes** the primitives already built — it does NOT rebuild them. `normalizePhoneE164`, `detectPhoneDuplicates`, the read-then-branch `repo.create()` (with its resurrect + 23505 handling), RLS via `withTenant`, and `Result<T,E>` are all reused as-is. The new surface is one pure service + one route + the per-row report contract.

## 2. Scope

### In-scope (this slice)
- A pure service `importContacts(repo, rows)` in `apps/backend/src/contacts/contacts.import.ts` — takes a `ContactsRepository` port (DB-independent, unit-testable), returns an `ImportReport`.
- `POST /contacts/import` route added **inline in `contacts.route.ts`** (the file is small; a new file would only add wiring noise).
- Zod schemas: per-row (`phone` required; `fullName`/`source`/`tags`/`intent`/`intentConfidence` optional) + batch (`contacts` non-empty, **≤ 200 rows**).
- Per-row outcome enum + aggregate counts (the report contract).
- Unit tests for `importContacts` (mock repo, no DB) + Testcontainers integration test `contacts.import.int.test.ts` (connected as `app_rls`).

### Out-of-scope (explicitly deferred)
| Deferred item | Why | Where it lands |
|---|---|---|
| **CSV / multipart upload** | Needs the Next.js dashboard upload UI; Corte 1 is backend-only. JSON is the right shape for a programmatic/internal caller now. | Later slice (Corte 1 web or later) |
| **Set-based bulk SQL** (one SELECT + multi-row INSERT) | Per-row reuse of `create()` is correct and fast enough at ≤200 rows; set-based adds raw-SQL duplication of resurrect logic for no payoff yet. | Future change when N > 500 |
| **`bulkCreate(tx, rows[])` single-transaction method** | Would require an outer `withTenant` wrapping per-row work → **nested transaction**, which postgres.js/Drizzle does not support. | Not planned |
| **Async / job-queued import (pg-boss)** | Synchronous is fine for ≤200 rows; no need for a worker round-trip yet. | Future, large imports |
| **Partial-failure rollback / all-or-nothing** | Best-effort per-row is the desired UX (import the good rows, report the rest). | Not planned |

## 3. Decisions

### D1. Input format → **JSON array, max 200 rows** (CSV deferred)
Body: `{ "contacts": [ { phone, fullName?, source?, tags?, intent?, intentConfidence? }, ... ] }`, `Content-Type: application/json`. Matches every existing route (`c.req.json()` + Zod), zero new deps. **Limit = 200.** Rationale: the per-row strategy (D2) does 1 transaction per unique valid row; 200 round-trips is well within a single HTTP request budget and keeps the integration test fast, while comfortably covering a small-business address book. >500 is where set-based becomes worth its complexity (deferred). CSV upload is deferred until the dashboard exists.

### D2. Transaction / dedupe strategy → **per-row best-effort reusing `repo.create()`** (set-based deferred)
Each valid, in-batch-unique row calls `repo.create(row)` — **its own `withTenant` transaction**. NEVER wrap these in an outer `withTenant` (nested `db.transaction()` is unsupported by postgres.js → silent/erroring). In-batch dedup runs in JS memory BEFORE any DB hit: normalize per row, then `detectPhoneDuplicates` over the normalized phones; only the first occurrence of each phone is sent to the DB, later occurrences are reported `skipped-duplicate-in-batch`. The concurrent-create race (another request claims a phone between dedup and insert) is already handled by the 23505 catch inside `create()`, which surfaces as `skipped-already-exists`. **vs set-based:** set-based (2 SELECT + multi-row INSERT + UPDATE) is fewer round-trips but duplicates the repo's resurrect/partial-index logic in raw SQL and can't use `ON CONFLICT` (partial unique index excludes soft-deleted rows). Not worth it at ≤200 rows.

### D3. Resurrect-in-bulk → **YES, resurrect (consistent with `create()`)**, reported as a distinct outcome
Importing a phone that matches a **soft-deleted** contact resurrects it (clears `deleted_at`, applies new fields, same id) — exactly what `repo.create()` already does. Rationale: behavioral consistency between single-create and bulk-import is more important than a marginally simpler report; a silently-different bulk path is a footgun. The resurrection is made **visible** via its own per-row status (`resurrected`) and its own aggregate count, so the operator is never surprised that a previously-deleted contact came back.

### D4. Per-row report + HTTP status → **200 + report** (not 207)

**Per-row outcome enum** (`status`):

| status | meaning | extra fields |
|---|---|---|
| `imported` | new row inserted | `contactId` |
| `resurrected` | soft-deleted row reactivated (same id) | `contactId` |
| `skipped-invalid-phone` | `normalizePhoneE164` rejected the phone | `reason` (`EMPTY_INPUT`/`INVALID_FORMAT`) |
| `skipped-duplicate-in-batch` | same normalized phone earlier in the batch | `canonicalRowIndex` |
| `skipped-already-exists` | a live contact already owns this phone | — |

**Response body:**
```json
{
  "summary": {
    "total": 5, "imported": 2, "resurrected": 1,
    "skippedInvalidPhone": 1, "skippedDuplicateInBatch": 0, "skippedAlreadyExists": 1
  },
  "rows": [
    { "rowIndex": 0, "status": "imported", "contactId": "<uuid>" },
    { "rowIndex": 1, "status": "skipped-invalid-phone", "reason": "INVALID_FORMAT" },
    { "rowIndex": 2, "status": "resurrected", "contactId": "<uuid>" },
    { "rowIndex": 3, "status": "skipped-already-exists" },
    { "rowIndex": 4, "status": "skipped-duplicate-in-batch", "canonicalRowIndex": 0 }
  ]
}
```
`rowIndex` is the 0-based position in the submitted `contacts` array; `rows` preserves submission order so the operator can map outcomes back to their input. **HTTP 200, not 207:** the batch call itself succeeded — partial per-row outcomes are normal domain results, not transport errors. 207 is uncommon in REST, unused in this codebase, and forces clients into special-case handling for no gain. An unexpected infra failure (`DB_ERROR` from the repo) is the only thing that produces a non-200 (500); Zod/limit failures are 400 before any row is processed.

### D5. Code placement → **service takes a port; route inline**
- `contacts.import.ts` exports `importContacts(repo: ContactsRepository, rows: ImportRow[]): Promise<ImportReport>` — pure orchestration over the repo port, so it is unit-testable with a mock repo and zero DB.
- `POST /contacts/import` added **inline in `contacts.route.ts`** alongside the other routes; it builds the repo from `c.get('tenantId')` exactly like the existing handlers, parses with Zod, calls `importContacts`, returns 200 + report. A separate `contacts.import.route.ts` is rejected — the route file is still small and a new file only adds export/import plumbing.

### D6. Validation → **Zod per-row + batch-level**
```ts
const importRowSchema = z.object({
  phone: z.string().min(1),
  fullName: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  intent: z.string().nullable().optional(),
  intentConfidence: z.number().min(0).max(1).nullable().optional(),
});
const importBodySchema = z.object({
  contacts: z.array(importRowSchema).min(1).max(200),
});
```
Empty array → 400 (`min(1)`); over-limit → 400 (`max(200)`); malformed row → 400 `VALIDATION_ERROR` (same shape as existing routes). Phone *semantic* validity is NOT a Zod concern — an invalid Peru mobile is a per-row `skipped-invalid-phone` in the 200 report, not a 400. Zod only guards structure and batch bounds.

## 4. Important reuse facts (honored)
- **`normalizePhoneBatch` loses row index** → the service calls `normalizePhoneE164` **per row in a loop**, tracking the original index, so every outcome maps to its `rowIndex`. `detectPhoneDuplicates` is fed the normalized valid phones in positional order; its 0-based indexes map cleanly back.
- **Partial unique index blocks `ON CONFLICT`** → resurrect MUST go through `create()`'s read-then-branch; do not reinvent with upsert.
- **No nested transactions** → per-row `repo.create()` (one `withTenant` each) is the only safe reuse path.

## 5. Capabilities (contract with sdd-spec)

### New Capabilities
- `contacts-bulk-import`: `importContacts` service + `POST /contacts/import` route + import Zod schemas + the per-row `ImportReport` outcome contract (statuses, summary counts, response shape).

### Modified Capabilities
- None. `repo.create()` behavior is **reused unchanged**; no requirement of `contacts-persistence` or `contacts-crud-api` changes.

## 6. Affected areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/backend/src/contacts/contacts.import.ts` | New | Pure `importContacts(repo, rows)` service + `ImportRow`/`ImportReport`/`RowOutcome` types |
| `apps/backend/src/contacts/contacts.route.ts` | Modified | Add `importBodySchema` + `POST /contacts/import` handler (build repo from tenant, call service, return 200 + report) |
| `apps/backend/test/contacts/contacts.import.test.ts` | New | Unit tests over mock repo (no DB) — all outcome paths |
| `apps/backend/test/contacts/contacts.import.int.test.ts` | New | Testcontainers integration (as `app_rls`): happy path, mix, in-batch dup, already-exists, resurrect, empty/over-limit, tenant isolation, route shape |

## 7. Non-goals / first-slice boundaries
- No CSV/multipart, no async job queue, no set-based SQL, no `bulkCreate` repo method.
- No all-or-nothing rollback — best-effort per row by design.
- No change to `repo.create()`, the schema, RLS, or the `ContactLead` contract.
- No web UI.
- No explicit `WHERE tenant_id` anywhere — RLS via `withTenant` only.

## 8. Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Resurrect surprises the operator (deleted contact comes back) | Med | Distinct `resurrected` status + count makes it explicit in the report (D3) |
| Row-index drift between input and report | Med | Normalize per row tracking index; never rely on `normalizePhoneBatch` ordering (Section 4) |
| Accidental outer `withTenant` wrapping → nested-tx failure | Low | Service takes a repo port and calls `create()` per row; the no-nesting rule is documented and there is no place to wrap |
| Concurrent create claims a phone mid-batch | Low | `create()`'s 23505 catch → reported as `skipped-already-exists` |
| 200 rows × per-row tx slower than set-based | Low | Acceptable at this limit; set-based deferred to >500 (D1/D2) |
| Integration test container cold-start cost | Low | Share one `createTestDb()` per file; `truncate()` between tests |

## 9. Rollback plan
Pure additive change. Rollback = delete `contacts.import.ts` + its two test files and revert the `POST /contacts/import` block (and `importBodySchema`) in `contacts.route.ts`. No migration, no schema change, no data change, nothing else imports the new symbols — zero blast radius.

## 10. Dependencies
- Reuses (no changes): `phone-e164.ts` (`normalizePhoneE164`, `detectPhoneDuplicates`), `contacts.repository.ts` (`createContactsRepository`, `repo.create`), `contacts.route.ts` wiring, `db/client.ts` (`withTenant`), `shared/result.ts`, `test/_helpers/test-db.ts`.
- No new runtime dependency.

## 11. Success criteria
- [ ] `POST /contacts/import` accepts `{ contacts: [...] }`, returns 200 + `{ summary, rows }` with correct per-row statuses.
- [ ] In-batch duplicates → first `imported`/`resurrected`, rest `skipped-duplicate-in-batch` with `canonicalRowIndex`.
- [ ] Invalid Peru mobile → `skipped-invalid-phone` (200, not 400).
- [ ] Existing live phone → `skipped-already-exists`; soft-deleted phone → `resurrected` (same id).
- [ ] Empty array and >200 rows → 400 `VALIDATION_ERROR`.
- [ ] Tenant isolation holds (import for A invisible to B), verified via Testcontainers as `app_rls`.
- [ ] `importContacts` unit-tested with a mock repo (no DB) covering every outcome.
- [ ] No `WHERE tenant_id`; no nested transactions; `Result<T,E>` in domain.

## 12. Review Workload Forecast

| File | Est. changed lines (code+tests) |
|------|---------------------------------|
| `contacts.import.ts` (service + types) | ~110–150 |
| `contacts.route.ts` (schema + handler) | ~40–60 |
| `contacts.import.test.ts` (unit) | ~140–200 |
| `contacts.import.int.test.ts` (integration) | ~160–240 |
| **Total** | **~450–650** |

- **400-line budget risk: High** — the explore's own estimate (~450–650) exceeds the 400-line default budget.
- **Chained PRs recommended: No** — the slice is one cohesive, atomic unit (service + its route + its tests); splitting service from tests, or route from service, produces non-autonomous, hard-to-review half-features. The overflow is dominated by test code, which is low-risk to review in bulk.
- **Decision needed before apply: Yes** — `delivery_strategy = ask-on-risk`; recommend a single PR with an accepted `size:exception` (justified: cohesive additive slice, majority is tests, zero blast radius per the rollback plan). If the team prefers strict budget adherence, the only sensible split is PR1 = service + unit tests, PR2 = route + integration tests — but this is NOT recommended.

## 13. Next recommended
`sdd-spec` and `sdd-design` (can run in parallel). Spec turns the per-row outcome contract + endpoint behavior into testable scenarios; design pins the normalize→dedup→per-row-create composition, the port boundary for unit-testability, and the no-nested-transaction reuse rule.
