# Archive Report — contactlead-routing

**Change**: contactlead-routing
**Archived**: 2026-06-23
**Status**: COMPLETE and VERIFIED
**Merged to main**: HEAD = 5a8f05f

---

## Executive Summary

ContactLead routing (core transactional outbox slice) is fully implemented, verified (128/128 tests GREEN, fresh review PASS), and merged to main. The change delivers an atomic routing service that marks contacts as routed and persists ContactLead payloads into a tenant-isolated outbox. No regressions detected.

---

## What Shipped

### Core Routing Capability
- Pure `mapContactToContactLead(contact, tenantId): ContactLead` — field mapping + `contactLeadSchema` validation as the contract guard (ADR-4).
- Atomic `routeContact(withTenant, tenantId, contactId): Promise<Result<ContactLead, ContactRoutingError>>` service running ONE `withTenant` transaction (design-gated correction from proposal: ADR-3).
- `POST /contacts/:id/route` endpoint mapping `Result<ContactLead, ContactRoutingError>` to HTTP (200/404/422/500).
- `ContactRoutingError` discriminated union (`CONTACT_NOT_FOUND | MISSING_FULL_NAME | DB_ERROR`).

### Transactional Outbox
- New `contact_lead_outbox` table: `id uuid PK`, `tenant_id`, `contact_id`, `payload jsonb`, `status text DEFAULT 'pending'`, `created_at`.
- RLS: `ENABLE ROW LEVEL SECURITY FORCE` + `tenant_isolation` policy (USING+WITH CHECK on `tenant_id`).
- `GRANT SELECT, INSERT ON contact_lead_outbox TO app_rls` (test-verified via Testcontainers as app_rls).
- Atomicity guarantee: `routed_at` UPDATE and outbox INSERT committed in ONE transaction or rolled back together.

### Schema + Migration
- `contacts.routed_at TIMESTAMPTZ NOT NULL DEFAULT NULL` (nullable, NULL = not yet routed).
- Multi-file ordered migration runner: `MIGRATION_FILES = ['0000_contacts.sql', '0001_routing.sql']` (idempotent, append-only, no ledger per ADR-5).
- New `0001_routing.sql` (idempotent DDL: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` + create, `ENABLE/FORCE RLS`, `GRANT`).
- Drizzle `contactLeadOutboxTable` + `routedAt` column in `Contact` type and mapper.

### Test Coverage
- Unit: `contacts.routing.map.test.ts` — mapper field mapping, null→undefined coercion, `contactLeadSchema.safeParse` validation (Docker-free).
- Integration: `contacts.routing.int.test.ts` — 7 scenarios (Testcontainers, shared container, 128/128 total with prior tests):
  1. Happy path: route valid named contact → `routed_at` set + exactly ONE outbox row.
  2. Not found: random UUID → 404 + zero outbox rows.
  3. Soft-deleted = not found: 404 + zero rows.
  4. Null `full_name` → 422 `MISSING_FULL_NAME`, no row, `routed_at` null.
  5. No-op idempotency: route twice → same outbox row, `routed_at` unchanged.
  6. Tenant isolation: tenant A→B reads via RLS return zero rows (GRANT verified).
  7. **Negative atomicity (MANDATORY TEST)**: forced INSERT failure (REVOKE INSERT then GRANT in finally block) → both writes rolled back, `routed_at` NULL, zero outbox rows.
- HTTP: `/contacts/:id/route` endpoint tested through Hono app with `X-Tenant-Id` header.

---

## Design-Gate Corrections Applied

### Correction 1: Atomicity Pattern (ADR-3)
**Issue**: Proposal mentioned `routeContact(id, repo, db)` with `repo.findById`, which opens its own transaction and commits before the outbox write. Non-atomic — race window for concurrent re-routes.

**Fix**: Design specified `routeContact(withTenant, tenantId, contactId)` performs SELECT inside the SAME `withTenant` transaction as the writes. Outer `.catch()` pattern on the Promise wraps the entire `withTenant(...)` call for infra error handling. Both writes (UPDATE + INSERT) use the same `tx` handle → atomic commit or rollback.

**Verification**: Negative atomicity test forces INSERT to fail (REVOKE + GRANT pattern), asserts `routed_at` rollback + zero outbox rows. TEST PASSED.

### Correction 2: Signature Reconciliation (ADR-3)
**Issue**: Delta spec referenced stale signature.

**Fix**: Updated spec.md (in openspec delta) to reflect canonical signature `routeContact(withTenant: TenantRunner, tenantId: string, contactId: string)`. Spec notes ADR-3 correction and references design section 4.3 and ADR section 6.

**Verification**: Spec merged into main contacts spec with note intact. No behavioral change.

### Correction 3: Mapper Type Safety
**Issue**: `exactOptionalPropertyTypes` strict TS mode rejects assigning `undefined` to optional properties via direct property assignment. Used `...(x != null ? { key: x } : {})` conditional spread pattern instead of `key: x ?? undefined`.

**Fix**: Applied spread pattern for `intent`, `intent_confidence` (null→spread omit, no undefined assignment). Passed `tsc --noEmit`.

**Verification**: tsc --noEmit: CLEAN (0 errors).

---

## Multi-File Migration Runner Refactor

### What Changed
- **Before**: Single hardcoded `MIGRATION_SQL_PATH` constant; one file read in `migrate.ts`.
- **After**: Explicit `MIGRATION_FILES = ['0000_contacts.sql', '0001_routing.sql'] as const` ordered array; loop applies each file.
- **Idempotency**: `makeIdempotent(raw, appRlsPassword)` applied to every file. Matches `CREATE ROLE app_rls` line in 0000 only; for 0001 (no role line) it's a no-op `String.replace` → returns unchanged. Harmless to both files.
- **Test path**: `test-db.ts` runs the same ordered list raw (no `makeIdempotent`; uses literal test password in 0000).

### No Regression
- Fresh DB: applies `[0000, 0001]` → contacts table created + routed_at added + outbox table + RLS + GRANT.
- Existing DB re-run: both files idempotent → all statements are `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS` + create → zero side effects.
- Integration tests confirm migration works on fresh container; all 128 tests pass.

---

## Files Created
- `apps/backend/drizzle/0001_routing.sql`
- `apps/backend/src/db/schema/contact-lead-outbox.schema.ts`
- `apps/backend/src/contacts/contacts.routing.ts` (mapper + service)
- `apps/backend/src/contacts/contacts.routing.errors.ts`
- `apps/backend/test/contacts/contacts.routing.map.test.ts`
- `apps/backend/test/contacts/contacts.routing.int.test.ts`
- `apps/backend/test/db/migrate.routing.int.test.ts`

## Files Modified
- `apps/backend/src/db/migrate.ts` (multi-file runner)
- `apps/backend/src/db/schema/contacts.schema.ts` (add routedAt)
- `apps/backend/test/_helpers/test-db.ts` (run both migrations, truncate both tables)
- `apps/backend/src/contacts/contacts.route.ts` (add POST /:id/route handler)
- `openspec/changes/2026-06-23-contactlead-routing/spec.md` (reconciled signature)
- `openspec/changes/2026-06-23-contactlead-routing/tasks.md` (all tasks marked complete)

---

## Test Results

**Total Test Count**: 128 tests (105 prior contacts tests + 23 new routing tests)
**Status**: ALL GREEN (0 failures, 0 regressions)
**Strict TDD Cycle**: RED → GREEN → REFACTOR (all phases executed per SDD tasks)

| Test Suite | Count | Status |
|-----------|-------|--------|
| contacts (existing CRUD) | 105 | PASS |
| contacts.routing.map | 5 | PASS |
| contacts.routing.int (7 scenarios + 4 HTTP) | 11 | PASS |
| migrate.routing.int (schema + migration) | 7 | PASS |

**Static Analysis**:
- `tsc --noEmit`: CLEAN (0 errors)
- `biome check`: CLEAN (all new/modified files)

---

## SDD Artifact References

| Artifact | Topic Key | Observation ID |
|----------|-----------|----------------|
| Proposal | sdd/contactlead-routing/proposal | 2524 |
| Spec | sdd/contactlead-routing/spec | 2526 |
| Design | sdd/contactlead-routing/design | 2527 |
| Tasks | sdd/contactlead-routing/tasks | 2529 |
| Apply Progress | sdd/contactlead-routing/apply-progress | 2530 |
| Verify Report | (not saved to engram; see below) | — |

**Note on verify-report**: The verify-report was generated during the verify phase but not saved to engram (verify phase is currently on the critical path and skips engram persistence in this workflow). The verification artifacts are captured in the apply-progress observation (2530) which documents all test results (14 files, 128 tests, 0 failures).

---

## Risks and Known Limitations

### No Risks Found
- All CRITICAL items from design resolved (atomicity test PASSED, signature reconciled, mapper type-safe).
- No regressions: all 105 existing contacts tests still GREEN.
- RLS enforcement verified: app_rls can INSERT to outbox (GRANT test passed); cross-tenant reads blocked (isolation test passed).

### Follow-Up Changes (Out of Scope, Documented)
1. **`contactlead-routing-worker`** (future): Drain the outbox via a scheduled worker. Must use `withTenant(tenant_id, …)` for any domain write (forward constraint documented in design §5).
2. **Outbox TTL / Monitoring** (future): Clean up old rows; alert on pending backlog.
3. **Status Index** (future): Add index on `status` for efficient polling if outbox grows large.

### No Production Consumer
The outbox rows accumulate indefinitely until the worker is built. This is intentional (by design, out-of-scope in this slice). No regressions to existing contacts behavior.

---

## Conclusion

The contactlead-routing change is COMPLETE, VERIFIED, and MERGED. All design requirements met, all tests pass, all spec sections coherent and merged into the main contacts spec. Ready for the next change.

Archived to `openspec/changes/archive/2026-06-23-contactlead-routing/` and persisted via Engram topic_key `sdd/contactlead-routing/archive-report`.
