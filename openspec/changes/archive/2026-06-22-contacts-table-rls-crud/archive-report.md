# Archive Report — contacts-table-rls-crud

> SDD archive phase · Project: sivi-whatsapp-hub · Change: contacts-table-rls-crud
> Archived: 2026-06-22 · Status: COMPLETE

---

## Executive Summary

The `contacts-table-rls-crud` change implements the first persisted data table for the WhatsApp Hub, with mandatory multi-tenant isolation via Postgres RLS. Two slices (Slice A: DB infrastructure + RLS + middleware; Slice B: repository + CRUD API) were planned, fully implemented, verified, and merged to main (HEAD = 3531f42). All 88 tests passing (29 pre-existing + 9 env + 5 middleware + 5 RLS integration + 17 repository integration + 23 route integration). tsc clean, biome clean.

---

## Traceability: Artifact Observation IDs

| Artifact | Topic Key | Observation ID |
|----------|-----------|----------------|
| Proposal | sdd/contacts-table-rls-crud/proposal | 2444 |
| Spec | sdd/contacts-table-rls-crud/spec | 2448 |
| Design | sdd/contacts-table-rls-crud/design | 2447 |
| Tasks | sdd/contacts-table-rls-crud/tasks | 2456 |
| Apply Progress | sdd/contacts-table-rls-crud/apply-progress | 2466 |
| Archive Report | sdd/contacts-table-rls-crud/archive-report | (this doc) |

---

## Change Scope: Two Slices

### Slice A: DB Infrastructure + RLS + Tenant Middleware
**Status**: COMPLETE ✓ · Commits: 3 work-unit commits

- **Env config + Drizzle setup** (1.1–1.9)
  - Zod env schema: DATABASE_URL, DATABASE_ADMIN_URL, AUTH_MODE, PORT, LOG_LEVEL
  - drizzle-orm + postgres + drizzle-kit + @testcontainers/postgresql deps added
  - drizzle.config.ts, compose.yaml created
  - vitest.config.ts updated: 60s/120s timeouts, *.int.test.ts glob

- **Contacts table + RLS + app_rls role** (1.4–1.6)
  - Contacts table: 11 columns (id, tenant_id, phone_e164, full_name, source, tags, intent, intent_confidence, created_at, updated_at, deleted_at)
  - intent_confidence: NUMERIC(5,4) nullable, CHECK (0–1), app-set as JS number
  - Unique constraint: (tenant_id, phone_e164)
  - RLS policy tenant_isolation: USING + WITH CHECK on tenant_id = current_setting('app.current_tenant')::uuid
  - app_rls role: non-superuser, NOBYPASSRLS, GRANT SELECT/INSERT/UPDATE/DELETE on contacts
  - Partial unique index: (tenant_id, phone_e164) WHERE deleted_at IS NULL

- **DB client + withTenant helper** (1.7)
  - createDbClient(env): dual connections (app_rls via DATABASE_URL, adminSql via DATABASE_ADMIN_URL)
  - withTenant(tenantId, run): db.transaction() + set_config('app.current_tenant', tenantId, true) + drizzle(tx)
  - Make-or-break invariant: every contacts query inside withTenant tx; no escape hatch in repository layer

- **Test infrastructure** (2.1)
  - createTestDb(): Testcontainers PostgreSQLContainer, runs migration, returns scoped client + seedTenant + truncate + teardown
  - 60s/120s vitest timeouts for container startup/teardown

- **RLS verification** (2.2–2.4)
  - rls.int.test.ts: 5 cross-tenant isolation scenarios (SELECT, UPDATE, DELETE, no-SET-LOCAL, app-role enforcement)
  - health.test.ts regression: buildApp() no-arg path untouched

- **Tenant middleware** (3.1–3.2)
  - createTenantMiddleware(env): AUTH_MODE=dev-header reads X-Tenant-Id header
  - Valid UUID → c.set('tenantId'); missing → 401; invalid → 400
  - AUTH_MODE=jwt → 501 stub (deferred)

**Test count after Slice A**: 48 passing (29 pre-existing + 9 env + 5 middleware + 5 RLS integration)

---

### Slice B: Repository + CRUD API + Boot Sequence
**Status**: COMPLETE ✓ · Commits: embedded in main branch

- **Contact domain type + errors** (4.1)
  - Contact: id, tenantId, phoneE164, full_name, source, tags, intent, intentConfidence, createdAt, updatedAt, deletedAt
  - ContactError union: CONTACT_NOT_FOUND, CONTACT_ALREADY_EXISTS, INVALID_PHONE, DB_ERROR (no throw)

- **Repository layer** (5.1–5.3)
  - createContactsRepository(withTenant, tenantId): Result-based CRUD ops
  - create: normalizePhoneE164 → conflict check → resurrect soft-deleted OR insert → 409 on live duplicate
  - findById/list: filter deleted_at IS NULL (soft-deleted invisible)
  - update: partial patch, app-set updated_at, 404 on soft-deleted target
  - softDelete: idempotent via existence check (404 on missing, ok on already-deleted)
  - ZERO WHERE tenant_id in any query (RLS enforces)
  - 17 integration test scenarios, all passing

- **Result→HTTP mapper + CRUD routes** (6.1–6.3)
  - resultToResponse: CONTACT_ALREADY_EXISTS→409, NOT_FOUND→404, INVALID_PHONE→422, DB_ERROR→500
  - createContactsRoute(deps): Hono router with tenantMiddleware on all routes
  - POST /contacts: 201 created
  - GET /contacts: 200 { data: [...] } ordered created_at DESC
  - GET /contacts/:id: 200 active, 404 soft-deleted/missing
  - PATCH /contacts/:id: 200 patched, 404 soft-deleted/missing
  - DELETE /contacts/:id: 204 soft-delete, 404 missing
  - 23 route integration test scenarios, all passing

- **Boot sequence wiring** (7.1–7.4)
  - buildApp(deps?): optional deps, mounts contacts routes only when deps present; no-arg → health only
  - main.ts: loadEnv → createDbClient → buildApp({db,env}) → serve on PORT
  - Migration runner: dedicated pnpm migrate script (not in main.ts)
  - Graceful shutdown: SIGTERM/SIGINT closes db pools

**Test count after Slice B**: 88 passing (48 + 17 repo int + 23 route int)
**Final sweep**: pnpm test all green, pnpm typecheck clean, pnpm lint clean

---

## Design Gate Corrections (Rev 1 → Rev 2)

The design phase uncovered 6 critical decision points that required clarification before implementation:

1. **RLS transaction boundary**: Must use db.transaction() + set_config with parameterized UUID (not raw string interp). Pooled connections in SET LOCAL session mode break isolation — pooling may hand next query to different connection.
   - **Resolved**: SET LOCAL (parameterized) inside sql.begin tx, Drizzle bound to same tx conn ✓

2. **Tenant middleware placement**: Must gate dev-header to AUTH_MODE env, never default to production.
   - **Resolved**: AUTH_MODE enum, 401 on missing, 400 on invalid UUID ✓

3. **intent_confidence storage + retrieval**: Driver (postgres.js) returns NUMERIC as string; app must coerce to JS number.
   - **Resolved**: numeric(5,4) CHECK (0–1), row mapper via Number(), tests verify typeof==='number' ✓

4. **Soft-deleted conflict semantics**: Upsert resurrection vs. pure conflict.
   - **Resolved**: No silent upsert; on conflict with soft-deleted row, resurrect (clear deleted_at) ✓

5. **updated_at strategy**: DB trigger vs. app-set.
   - **Resolved**: App-set new Date() on every write (testable, no trigger footprint) ✓

6. **buildApp regression risk**: No-arg path must not regress health.test.ts.
   - **Resolved**: buildApp(deps?) optional, health-only when deps absent ✓

All 6 CRITICAL issues resolved before implementation began.

---

## Implementation Notes

### Gotchas and Learnings (from apply-progress #2466)

1. **drizzle-orm v0.45 + postgres.js transaction issue**: Cannot call `drizzle(txSql)` inside `sql.begin()`. txSql is a TransactionSql, lacks parsers. Must use `db.transaction()` directly, bind Drizzle to same connection.

2. **RLS with custom GUC**: When SET LOCAL 'app.current_tenant' is not set, RLS policy NULLIF(current_setting(..., true), '')::uuid returns NULL, matches fail, 0 rows returned (correct default-deny). Without NULLIF: "unrecognized configuration parameter" error on missing setting.

3. **CREATE ROLE password in migration**: Cannot use psql variable syntax (:'pw') with postgres.js driver. Must use LITERAL 'testpassword' in SQL file.

4. **Biome rule noDelete**: Reflect.deleteProperty(obj, key) instead of delete obj[key] to satisfy linter.

5. **.env.example dotfile**: Write tool permission denied on Windows. Deferred — not test-critical.

6. **Branch**: feat/contacts-table-rls-crud (3 commits on main)

---

## Test Coverage

| Category | Count | Status |
|----------|-------|--------|
| Pre-existing (Corte 0 health) | 29 | ✓ |
| Env config (Zod, loadEnv) | 9 | ✓ |
| Tenant middleware (headers, UUID) | 5 | ✓ |
| RLS cross-tenant isolation | 5 | ✓ |
| Repository integration (CRUD scenarios) | 17 | ✓ |
| Route integration (HTTP scenarios) | 23 | ✓ |
| **Total** | **88** | ✓ Green |

**Quality**: pnpm test all passing, pnpm typecheck clean, pnpm lint clean.

---

## Specs Merged into Main

### File: openspec/specs/contacts/spec.md

**Action**: Extended with three new capabilities + one existing capability extension

1. **NEW: tenant-isolation**
   - Contacts table shape (11 cols + constraints)
   - RLS policy tenant_isolation (SELECT/INSERT/UPDATE/DELETE isolation)
   - Tenant middleware (X-Tenant-Id header, 401/400 responses)

2. **NEW: contacts-persistence**
   - Repository interface (create/findById/list/update/softDelete)
   - CRUD operation contracts (conflict semantics, soft-delete visibility, idempotency)
   - Domain errors (CONTACT_NOT_FOUND, CONTACT_ALREADY_EXISTS, INVALID_PHONE, DB_ERROR)

3. **NEW: contacts-crud-api**
   - Result→HTTP status mapping (409, 404, 422, 500, 400)
   - POST /contacts (create, 201)
   - GET /contacts (list, 200)
   - GET /contacts/:id (fetch, 200/404)
   - PATCH /contacts/:id (update, 200/404)
   - DELETE /contacts/:id (soft-delete, 204/404)

4. **EXTENDED: contacts (existing capability)**
   - Added: Contact domain type (all 11 fields matching table)

**Total additions**: ~1025 lines (requirements + scenarios) merged; existing Result/normalizer/dedupe sections preserved unchanged.

---

## Task Completion Status

### Slice A: Phases 1–3 (all checked)
- [x] 1.1–1.9: Env + Drizzle + table + RLS + app_rls
- [x] 2.1–2.4: Test infra + RLS scenarios + health regression
- [x] 3.1–3.2: Tenant middleware unit + impl

### Slice B: Phases 4–7 (all checked)
- [x] 4.1: Contact errors discriminated union
- [x] 5.1–5.3: Repository interface + integration tests + refactor audit
- [x] 6.1–6.3: Result→HTTP mapper + routes + integration tests
- [x] 7.1–7.4: buildApp wiring + main.ts boot + full suite green

**Reconciliation**: Tasks.md checkboxes updated to reflect completed implementation. Proof: apply-progress #2466 documents Slice A completion; Slice B files and passing tests confirm completion.

---

## Follow-Up Gaps (Known Non-Blockers)

1. **.env.example creation**: Dotfile write permission denied on Windows. Workaround: manually `cat > .env.example` with sample env vars. Not test-blocking.

2. **DATABASE_ADMIN_URL vs. DATABASE_URL password match**: app_rls role password must match the PASSWORD in drizzle/0000_contacts.sql. Currently hardcoded 'testpassword'. Prod: inject via env or secret manager before migration runs. TODO tracked separately.

3. **JWT AUTH_MODE implementation**: Stub returns 501. Next slice (contacts-routing / ContactLead) will wire JWT validation. Not blocking Corte 1.

---

## Files Changed

### Files Created
- apps/backend/src/config/env.ts + env.test.ts
- apps/backend/src/db/client.ts
- apps/backend/src/db/schema/contacts.schema.ts
- apps/backend/drizzle/0000_contacts.sql (hand-appended RLS)
- apps/backend/drizzle.config.ts
- apps/backend/src/http/tenant.middleware.ts + tenant.middleware.test.ts
- apps/backend/src/contacts/contacts.errors.ts
- apps/backend/src/contacts/contacts.repository.ts
- apps/backend/src/contacts/contacts.route.ts
- apps/backend/src/contacts/result-to-response.test.ts
- apps/backend/test/_helpers/test-db.ts
- apps/backend/test/contacts/rls.int.test.ts
- apps/backend/test/contacts/contacts.repository.int.test.ts
- apps/backend/test/contacts/contacts.route.int.test.ts
- apps/backend/compose.yaml

### Files Modified
- apps/backend/package.json (drizzle-orm, postgres, drizzle-kit, @testcontainers/postgresql)
- apps/backend/vitest.config.ts (testTimeout, hookTimeout, *.int.test.ts glob)
- apps/backend/src/app.ts (buildApp optional deps)
- apps/backend/src/main.ts (boot sequence with db client)
- openspec/specs/contacts/spec.md (merged delta spec, **1025+ lines added**)
- openspec/changes/2026-06-22-contacts-table-rls-crud/tasks.md (checkboxes 4.1–7.4 marked complete)

### Total Changed Lines
Slice A implementation: ~420 lines
Slice B implementation: ~600 lines
Spec merge: ~1025 lines
**Total**: ~2045 lines across implementation, tests, and specs.

---

## Rollback / Revert Path

- **Feature branch revert**: `git revert [commits]` or `git reset --hard main~N`
- **DB rollback**: DROP POLICY tenant_isolation ON contacts; DROP TABLE contacts; DROP ROLE app_rls
- **Soft rollback on prod**: Drop policy, keep table (allows re-app without migration)
- **Health + pure domain unaffected**: Corte 0 (buildApp no-arg path) remains stable

---

## SDD Cycle Closed

This change moved from **proposal → spec → design → tasks → apply → verify → archive** with all deliverables on main branch and all tests passing. The next Corte 1 slice (bulk import / ContactLead routing) can depend on this table + RLS + middleware foundation.

**Change status**: ARCHIVED ✓  
**Date archived**: 2026-06-22  
**Final commit**: 3531f42 (main)  
**Test suite**: 88/88 passing
