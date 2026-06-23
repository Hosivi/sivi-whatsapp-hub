# Archive Report — contacts-bulk-import

**Change**: contacts-bulk-import
**Status**: ARCHIVED — fully implemented, verified (105/105 tests GREEN), and merged to main (HEAD = 4f92c84)
**Date**: 2026-06-23
**Artifact Store**: hybrid (engram + openspec)

---

## Executive Summary

The `contacts-bulk-import` slice is complete and archived. The change introduced a production-ready bulk import service (`importContacts`) and HTTP endpoint (`POST /contacts/import`) that allows MYPEs to ingest 1–200 contacts in a single request, with per-row outcome reporting (imported, resurrected, skipped-invalid-phone, skipped-duplicate-in-batch, skipped-already-exists, or error). All 105 tests pass, the implementation honors strict TDD (RED → GREEN → REFACTOR per phase), tenant isolation via RLS, and pure functional DI over a repository port. The change is pure additive with zero blast radius. The main contacts spec has been synced with the new bulk import requirements.

---

## What Shipped

**Core deliverable**: `importContacts(repo, rows): Promise<ImportReport>` service + `POST /contacts/import` route.

| Component | Status | Summary |
|-----------|--------|---------|
| importContacts service | ✅ DONE | Pure orchestration: normalize → in-batch dedup → per-row repo.create + result mapping. Timestamp-based imported-vs-resurrected detection (ADR-001). Running Set dedup (ADR-002). DB_ERROR per-row error outcome (ADR-003). Zero DB logic, zero WHERE tenant_id. |
| POST /contacts/import route | ✅ DONE | Inline in contacts.route.ts. Zod validation (batch 1–200). TenantId from middleware. Returns 200 + report; 500 if summary.errors > 0. Batch-level 400 on empty/over-limit/malformed. |
| ImportRow / RowOutcome / ImportSummary / ImportReport types | ✅ DONE | 6 RowOutcome variants (imported, resurrected, skipped-invalid-phone, skipped-duplicate-in-batch, skipped-already-exists, error). Each outcome includes `index` (original row position) and `input` (echoed row). Summary tracks 7 buckets: total, imported, resurrected, skippedInvalidPhone, skippedDuplicateInBatch, skippedAlreadyExists, errors. |
| Unit tests (contacts.import.test.ts) | ✅ DONE | Docker-free, fake in-memory repo. All 7 outcome paths covered (new, invalid, within-batch dup, live, soft-deleted, DB_ERROR, mixed batch). Strict TDD RED → GREEN → REFACTOR per phase. |
| Integration tests (contacts.import.int.test.ts) | ✅ DONE | Testcontainers as app_rls. Real DB outcomes + timestamp-signal regression guards (createdAt < updatedAt on resurrect). Tenant isolation verified. Batch 400 validation confirmed. 7 integration cases all GREEN. |

**Files changed (6):**
1. `openspec/specs/contacts/spec.md` — MERGED (delta spec integrated as "Extended Capability: contacts-bulk-import" section)
2. `apps/backend/src/contacts/contacts.import.ts` — NEW (service + types)
3. `apps/backend/src/contacts/contacts.route.ts` — MODIFIED (POST /import inline + importBodySchema)
4. `apps/backend/test/contacts/contacts.import.test.ts` — NEW (unit tests)
5. `apps/backend/test/contacts/contacts.import.int.test.ts` — NEW (integration tests)
6. `openspec/changes/2026-06-22-contacts-bulk-import/*.md` → MOVED to `openspec/changes/archive/2026-06-22-contacts-bulk-import/` (proposal, spec, design, tasks)

---

## Design Gate Result

**PASS** (fresh design review in the apply phase).

All architectural constraints honored:
- ✅ Result<T,E> in domain; throw only at infra.
- ✅ NO WHERE tenant_id queries; RLS via withTenant only.
- ✅ Functional DI: repo passed as argument, no container/classes.
- ✅ NO nested withTenant: service has no withTenant access, per-row create each opens own tx.
- ✅ create() reused UNCHANGED; no return-type change, no new port surface.
- ✅ Timestamp-based imported-vs-resurrected mechanism (ADR-001) proven deterministic.
- ✅ Running Set in-batch dedup (ADR-002) eliminates row-index-drift risk.
- ✅ Per-row error outcomes + route 500-with-body (ADR-003) preserves observability.
- ✅ ImportRow = NewContactInput (ADR-004), single source of truth across single and bulk.

**Design decisions upheld:**
- D1: JSON, max 200 rows ✅
- D2: Per-row best-effort, JS dedup, no nested tx ✅
- D3: Resurrect distinct outcome + count ✅
- D4: 200 + per-row report (not 207) ✅
- D5: Service takes port, route inline ✅
- D6: Zod per-row + batch (semantic phone is per-row not batch) ✅

---

## Apply Gate Fix (Artifact Reconciliation)

**Issue**: Initial spec and design delta files used `rowIndex` and `status` field names; the orchestrator's canonical reconciliation (prep work in Phase 1) corrected them to `index` and `outcome` to match the final contract.

**Resolution**: Phase 1 tasks (1.1, 1.2) updated both spec.md and design.md in-place:
- `rowIndex` → `index` (preserves original row position in submission order)
- `status` (per-row field) → `outcome` (matches RowOutcome enum type name)
- Added `error` as the 6th RowOutcome variant
- Added `errors: number` to ImportSummary
- Updated summary invariant to include errors bucket
- Added `readonly input: ImportRow` to each RowOutcome variant for row echo

All references in code (contacts.import.ts) use the canonical `index` and `outcome` names. The contract is now consistent across spec, design, types, and implementation.

---

## Final Test Results

| Suite | Count | Status |
|-------|-------|--------|
| contacts.import.test.ts (unit) | 7 cases | ✅ GREEN |
| contacts.import.int.test.ts (integration) | 7 cases | ✅ GREEN |
| Full repo (pnpm test) | 105 tests | ✅ GREEN |
| Linting (biome) | — | ✅ CLEAN |
| Type checking (tsc) | — | ✅ CLEAN |

**Key regression guards**:
- Unit test 5 (soft-deleted → resurrected) + Integration test 5 (same): asserts contactId equality with original id, confirming createdAt < updatedAt signal works on real Postgres.
- Unit test 3 (within-batch dup) + Integration test 2 (same): fake and real DB confirm only ONE row persists, others skipped.
- Integration test 7 (tenant isolation): TENANT_A import invisible to TENANT_B, TENANT_B can import same phone fresh.

---

## Spec Sync

Main spec (`openspec/specs/contacts/spec.md`) now includes:

**New Section**: "Extended Capability: contacts-bulk-import"
- ImportRow Schema requirement (phone required, others optional)
- RowOutcome Enum (6 outcomes)
- importContacts Service specification
- POST /contacts/import endpoint behavior (200 + report, 500 on errors, 400 on batch validation)
- Batch-Level 400 Validation scenarios
- Tenant Isolation requirement
- Summary Counts consistency requirement
- 8 testable scenarios covering all outcomes and edge cases
- Out-of-Scope section (CSV/multipart, async/pg-boss, all-or-nothing, bulkCreate, set-based SQL, dashboard UI)

The canonical field names in the spec are:
- Per-row: `index` (0-based), `input` (echoed), `outcome` (RowOutcome union), `contactId?`, `reason?`, `canonicalRowIndex?`, `code?`
- Summary: `total`, `imported`, `resurrected`, `skippedInvalidPhone`, `skippedDuplicateInBatch`, `skippedAlreadyExists`, `errors`

---

## Artifact Observation IDs (Engram Traceability)

All phase artifacts retrieved and confirmed:

| Artifact | Engram ID | Topic Key |
|----------|-----------|-----------|
| Proposal | #2490 | sdd/contacts-bulk-import/proposal |
| Spec (delta) | #2493 | sdd/contacts-bulk-import/spec |
| Design | #2494 | sdd/contacts-bulk-import/design |
| Tasks | #2498 | sdd/contacts-bulk-import/tasks |
| Apply Progress | #2504 | sdd/contacts-bulk-import/apply-progress |
| Explore | #2489 | sdd/contacts-bulk-import/explore |

Archive report (this document) persists to Engram topic_key: `sdd/contacts-bulk-import/archive-report`.

---

## Deployment Readiness

- ✅ Code is merged to main (HEAD = 4f92c84, no uncommitted changes in feat/contacts-bulk-import).
- ✅ All tests pass locally and in CI.
- ✅ No schema migrations required (reuses existing contacts table + RLS).
- ✅ No config changes required.
- ✅ Backward compatible: single-create POST /contacts (201) unchanged; GET/PATCH/DELETE unaffected.
- ✅ Rollback plan: delete contacts.import.ts + 2 test files, revert POST /import block in contacts.route.ts. Zero blast radius.

---

## Follow-ups and Deferred Work

**Corte 1 Remaining** (outside this slice):
- Tags (Requirement: Contact Tags CRUD) — planned
- Manual intent assignment (Requirement: Manual Intent Labeling) — planned
- ContactLead routing (CRM contract integration) — planned

**Future improvements** (explicitly deferred):
- CSV/multipart upload → requires Next.js dashboard UI (later slice)
- Async/job-queued import (pg-boss) → future when batches exceed 500 rows
- Set-based SQL bulk insert → future when per-row latency becomes critical (N > 500)
- bulkCreate(tx, rows[]) method → deferred due to postgres.js nested transaction limitations
- All-or-nothing transactional rollback → not planned; best-effort per-row is the UX

---

## Summary Invariant (Verified)

```
summary.imported + summary.resurrected + summary.skippedInvalidPhone 
+ summary.skippedDuplicateInBatch + summary.skippedAlreadyExists 
+ summary.errors
= summary.total
```

Asserted in unit test 7 (mixed batch) and integration mixed scenarios. No row is unaccounted for.

---

## Archive Completeness

✅ All SDD artifacts (proposal, spec, design, tasks, apply-progress) retrieved from engram.
✅ Delta spec merged into main spec (field naming canonicalized).
✅ Change folder moved to archive (openspec/changes/archive/2026-06-22-contacts-bulk-import/).
✅ Archive folder contains: proposal.md, spec.md, design.md, tasks.md, archive-report.md.
✅ No unchecked implementation tasks remain in tasks.md (all Phase 1–5 complete).
✅ No CRITICAL issues in apply-progress or verify-report.
✅ Tenant isolation verified at the gate.

**SDD Cycle Status**: COMPLETE — change is closed and ready for the next slice.

---

## Notes for Reviewers / Maintainers

1. **Timestamp signal (ADR-001)**: The `resurrected` classification hinges on `createdAt < updatedAt`. This is guaranteed to work because:
   - Fresh INSERT: both timestamps default to `sql\`now()\`` (same statement → equal to microsecond).
   - Resurrect UPDATE: sets only `updatedAt: new Date()`, leaves `createdAt` untouched (older by definition).
   - Integration test 5 regression-guards this signal against real Postgres behavior.

2. **In-batch dedup (ADR-002)**: Uses running Set + first-index map, NOT `detectPhoneDuplicates`. The proposal authorized both; this design chose the index-trivial path. `detectPhoneDuplicates` remains in the codebase with its own tests; bulk-import simply doesn't route through it.

3. **DB_ERROR handling (ADR-003)**: Partial failures are recorded as per-row `error` outcomes; the service keeps processing. The route maps `summary.errors > 0` to HTTP 500, carrying the full report in the body so operators see which rows failed. If the spec later forbids a 500 body, the fallback is a bare 500 with no service logic change.

4. **Field naming**: The contract uses `index` (not `rowIndex`) and `outcome` (not `status`) to avoid collision with HTTP status codes and to follow the final spec convention. All 105 tests pass with these names; they are canonical.

5. **Rollback simplicity**: The slice is pure additive — no schema changes, no modifications to create() or any other existing behavior. Rollback is a few file deletions.
