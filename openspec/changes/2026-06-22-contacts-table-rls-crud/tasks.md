# Tasks: contacts-table-rls-crud

> SDD phase: tasks · Store: hybrid · Strict TDD: ACTIVE (pnpm test = Vitest)
> Design authority: `openspec/changes/2026-06-22-contacts-table-rls-crud/design.md` (Rev 2)
> Spec authority: `openspec/changes/2026-06-22-contacts-table-rls-crud/spec.md`

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~950–1 100 (additions + deletions) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR A (Slice A) → PR B (Slice B) — see work units below |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### File-by-file line estimate

| File | Est. lines |
|------|-----------|
| `apps/backend/package.json` (modify) | 10 |
| `apps/backend/drizzle.config.ts` (create) | 15 |
| `apps/backend/src/config/env.ts` (create) | 35 |
| `apps/backend/src/db/client.ts` (create) | 55 |
| `apps/backend/src/db/schema/contacts.schema.ts` (create) | 75 |
| `apps/backend/drizzle/0000_contacts.sql` (create) | 65 |
| `apps/backend/src/http/tenant.middleware.ts` (create) | 40 |
| `apps/backend/vitest.config.ts` (modify) | 10 |
| `apps/backend/test/_helpers/test-db.ts` (create) | 85 |
| `apps/backend/test/contacts/rls.int.test.ts` (create) | 90 |
| `apps/backend/test/contacts/contacts.repository.int.test.ts` (create) | 130 |
| `apps/backend/test/contacts/contacts.route.int.test.ts` (create) | 110 |
| `apps/backend/src/contacts/contacts.errors.ts` (create) | 20 |
| `apps/backend/src/contacts/contacts.repository.ts` (create) | 140 |
| `apps/backend/src/contacts/contacts.route.ts` (create) | 100 |
| `apps/backend/src/app.ts` (modify) | 20 |
| `apps/backend/src/main.ts` (modify) | 25 |
| `apps/backend/compose.yaml` + `.env.example` (create) | 35 |
| Unit tests: middleware + resultToResponse (create) | 65 |
| **Total** | **~1 025** |

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| Slice A | DB infra + RLS policy + `app_rls` role + env config + `withTenant` + tenant middleware; cross-tenant isolation proven end-to-end | PR 1 → main | Includes `rls.int.test.ts` going GREEN. `health.test.ts` must not regress. |
| Slice B | `Contact` type + errors + repository + CRUD routes + `buildApp` wiring + `main.ts`; all route status codes proven | PR 2 → main | Depends on PR 1 (DB client, env, middleware). |

---

## Phase 1: Dependencies, Config, and DB Foundation (Slice A)

- [ ] 1.1 **[unit · RED]** Write `apps/backend/src/config/env.test.ts`: assert `loadEnv()` throws when `DATABASE_URL` is missing; assert it parses `AUTH_MODE` enum `['dev-header','jwt']`; assert `PORT` defaults to 3001.
  _Spec: env validation fail-fast · Docker-free_

- [ ] 1.2 **[GREEN]** Create `apps/backend/src/config/env.ts`: Zod schema for `DATABASE_URL`, `DATABASE_ADMIN_URL` (both required), `AUTH_MODE` enum, `PORT` (default 3001), `LOG_LEVEL` (default `'info'`); export `Env` type and `loadEnv()` that calls `.parse(process.env)`.
  _Design: env validation fail-fast decision_

- [ ] 1.3 Add runtime deps `drizzle-orm`, `postgres` and dev deps `drizzle-kit`, `@testcontainers/postgresql` to `apps/backend/package.json`; run `pnpm install` to update lockfile.

- [ ] 1.4 Create `apps/backend/drizzle.config.ts`: dialect `postgresql`, schema glob `./src/db/schema/*.schema.ts`, `out: ./drizzle`; credentials from `DATABASE_ADMIN_URL` env var.

- [ ] 1.5 Create `apps/backend/src/db/schema/contacts.schema.ts`: Drizzle `contacts` table with all 11 columns from spec (UUID PK, `tenant_id`, `phone_e164`, `full_name`, `source`, `tags text[]`, `intent`, `intent_confidence numeric(5,4)`, `created_at`, `updated_at`, `deleted_at`). Include `intent_confidence` CHECK (0–1). Export `Contact` domain type with camelCase fields; row mapper converts `intent_confidence` string → `number` via `Number()`.
  _Spec: Contacts Table Shape · Design: intent_confidence + updated_at decision_

- [ ] 1.6 Run `pnpm drizzle-kit generate` to produce `apps/backend/drizzle/0000_contacts.sql` (base DDL), then hand-append RLS + role block:
  ```sql
  ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON contacts
    USING (tenant_id = current_setting('app.current_tenant')::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
  CREATE UNIQUE INDEX contacts_tenant_phone_uq ON contacts (tenant_id, phone_e164) WHERE deleted_at IS NULL;
  CREATE INDEX contacts_tenant_created_idx ON contacts (tenant_id, created_at);
  CREATE ROLE app_rls LOGIN PASSWORD :'app_rls_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  GRANT USAGE ON SCHEMA public TO app_rls;
  GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_rls;
  ```
  _Spec: RLS Tenant Isolation Policy, app-role enforcement · Design: non-superuser app role decision_

- [ ] 1.7 Create `apps/backend/src/db/client.ts`: export `TenantRunner`, `DbClient` types and `createDbClient(env: Env): DbClient`. The client opens two connections: `sql` via `DATABASE_URL` (connects as `app_rls`); `adminSql` via `DATABASE_ADMIN_URL` (privileged, migration only). `withTenant(tenantId, run)` uses `sql.begin` + `SELECT set_config('app.current_tenant', ${tenantId}, true)` then passes `drizzle(txSql)` to `run`. `adminSql` is NOT exposed to repositories.
  _Design: RLS transaction boundary — `withTenant` is the only path_

- [ ] 1.8 Create `apps/backend/compose.yaml` (PG16 service, port 5432) and `apps/backend/.env.example` (with `DATABASE_URL=postgresql://app_rls:...@localhost:5432/...`, `DATABASE_ADMIN_URL=postgresql://postgres:...@localhost:5432/...`, `AUTH_MODE=dev-header`).

- [ ] 1.9 Modify `apps/backend/vitest.config.ts`: add `testTimeout: 60_000`, `hookTimeout: 120_000`, and extend `include` to match both `test/**/*.test.ts` and `test/**/*.int.test.ts`.

---

## Phase 2: Test Helper + RLS RED→GREEN (Slice A, continued)

- [ ] 2.1 Create `apps/backend/test/_helpers/test-db.ts`: `createTestDb()` starts `PostgreSQLContainer('postgres:16-alpine')`, connects as superuser via `adminSql` to run `drizzle/0000_contacts.sql` (creates table + policy + `app_rls` + grants), then returns `{ withTenant (app_rls-scoped client), seedTenant(id), truncate(), teardown() }`. The app_rls client connects with `DATABASE_URL`-equivalent pointing at the container.
  _Design: createTestDb() spec · Integration (Testcontainers)_

- [ ] 2.2 **[int · RED]** Write `apps/backend/test/contacts/rls.int.test.ts` BEFORE the migration SQL exists in the container. Assert:
  - (a) `withTenant(tenantA)` → `SELECT * FROM contacts` returns only tenant A rows, not tenant B.
  - (b) `withTenant(tenantA)` → INSERT with `tenant_id = tenantB` is rejected by `WITH CHECK`.
  - (c) Connected as `app_rls` (not superuser): RLS is enforced (not bypassed).
  - (d) `withTenant(tenantA)` → UPDATE of a tenant B row → 0 rows affected.
  - (e) No `SET LOCAL` → empty result (default-deny).
  All five assertions MUST FAIL until 1.6 + 2.1 complete.
  _Spec: all RLS scenarios · Integration_

- [ ] 2.3 **[GREEN]** Verify `rls.int.test.ts` passes after applying 1.6 + 2.1 (the migration SQL + `createTestDb()` with the `app_rls`-scoped client).

- [ ] 2.4 Verify `apps/backend/test/health.test.ts` still passes (the no-arg `buildApp()` path mounts only health — zero regression).

---

## Phase 3: Tenant Middleware (Slice A)

- [ ] 3.1 **[unit · RED]** Write `apps/backend/src/http/tenant.middleware.test.ts`: mock Hono context; assert missing `X-Tenant-Id` → `401 { "error": "MISSING_TENANT" }`; non-UUID value → `400 { "error": "INVALID_TENANT_ID" }`; valid UUID → `c.set('tenantId', uuid)` and `next()` called.
  _Spec: Tenant Middleware scenarios · Docker-free_

- [ ] 3.2 **[GREEN]** Create `apps/backend/src/http/tenant.middleware.ts`: `createTenantMiddleware(env: Env)` → Hono middleware. When `env.AUTH_MODE === 'dev-header'`: read `X-Tenant-Id` header; missing → 401; present but fails `z.string().uuid()` → 400; valid → `c.set('tenantId', id); await next()`. When `AUTH_MODE === 'jwt'` → 501 stub.
  _Design: tenant middleware boundary decision_

---

## Phase 4: Contact Domain Types and Errors (Slice B setup)

- [ ] 4.1 Create `apps/backend/src/contacts/contacts.errors.ts`: export `ContactError` discriminated union with codes `CONTACT_NOT_FOUND`, `CONTACT_ALREADY_EXISTS`, `INVALID_PHONE`, `DB_ERROR`. No throw — these are domain `Result` errors only.
  _Spec: ContactsRepositoryError codes_

---

## Phase 5: Repository (Slice B)

- [ ] 5.1 **[int · RED]** Write `apps/backend/test/contacts/contacts.repository.int.test.ts`: using `createTestDb()`, assert all repository scenarios from spec:
  - `create` happy path: phone normalizes, `phoneE164` stored as E.164, `deletedAt` is null.
  - `create` live-conflict → `err(CONTACT_ALREADY_EXISTS)`.
  - `create` soft-deleted phone → resurrect, same `id`, `deletedAt` null.
  - `create` invalid phone → `err(INVALID_PHONE)`.
  - `findById` active → ok; soft-deleted → `CONTACT_NOT_FOUND`; missing → `CONTACT_NOT_FOUND`.
  - `list` excludes soft-deleted; returns `[]` when empty; ordered `created_at DESC`.
  - `update` partial patch, untouched fields unchanged, `updatedAt` bumped; soft-deleted target → `CONTACT_NOT_FOUND`.
  - `softDelete` active → ok; idempotent on already-deleted; missing id → `CONTACT_NOT_FOUND`.
  - `intentConfidence` returned as `typeof === 'number'` (not string).
  All assertions MUST FAIL before 5.2 exists.
  _Spec: all contacts-persistence scenarios · Integration_

- [ ] 5.2 **[GREEN]** Create `apps/backend/src/contacts/contacts.repository.ts`: `createContactsRepository(withTenant: TenantRunner, tenantId: string): ContactsRepository`. All ops run inside `withTenant(tenantId, ...)`. No `WHERE tenant_id` in any query (RLS handles it). `create` implements explicit read-then-branch (SELECT → live=409 / soft-deleted=resurrect / absent=INSERT + catch `23505`→409). `softDelete` idempotency via existence read (SELECT → absent=404 / already-deleted=ok / live=UPDATE). `findById`/`list` filter `deleted_at IS NULL`. Row mapper converts `intent_confidence` string → `number`. `updated_at` is app-set (`new Date()`) on every write.
  _Design: create conflict + resurrect, softDelete idempotency, withTenant constraint_

- [ ] 5.3 **[REFACTOR]** Verify no `WHERE tenant_id` leakage in `contacts.repository.ts`; confirm `adminSql` never appears in repository code; confirm every op is inside a `withTenant` call.

---

## Phase 6: HTTP Routes and Result→Response Mapper (Slice B)

- [ ] 6.1 **[unit · RED]** Write `apps/backend/src/contacts/result-to-response.test.ts`: assert `resultToResponse` mapping table: `CONTACT_ALREADY_EXISTS`→409, `CONTACT_NOT_FOUND`→404, `INVALID_PHONE`→422, `DB_ERROR`→500; Zod body failure→400 (tested at route layer, not mapper).
  _Spec: Result→HTTP Status Mapping · Docker-free_

- [ ] 6.2 **[GREEN]** Create `apps/backend/src/contacts/contacts.route.ts`: `createContactsRoute(deps: { db: DbClient; env: Env })` returns a Hono router. Mount `tenantMiddleware` on all contact routes. For each route, parse body via Zod schema (400 on failure), construct repo via `createContactsRepository(db.withTenant, c.get('tenantId'))`, call repo op, pass result to `resultToResponse`. Routes: `POST /` → 201 + contact; `GET /` → 200 + `{ data: [...] }`; `GET /:id` → 200 + contact; `PATCH /:id` → 200 + contact; `DELETE /:id` → 204.
  _Spec: all contacts-crud-api scenarios · Design: Result→HTTP mapping_

- [ ] 6.3 **[int · RED]** Write `apps/backend/test/contacts/contacts.route.int.test.ts`: using `createTestDb()` + `buildApp({ db, env })`, assert all HTTP scenarios from spec:
  - `POST /contacts` → 201; live phone → 409; invalid phone → 422; missing phone field → 400; missing tenant header → 401; non-UUID tenant → 400.
  - `GET /contacts` → 200 `{ data: [...] }`; empty → `{ data: [] }`.
  - `GET /contacts/:id` → 200; soft-deleted → 404; missing → 404.
  - `PATCH /contacts/:id` → 200; soft-deleted or missing → 404.
  - `DELETE /contacts/:id` → 204; subsequent GET → 404; missing → 404.
  All MUST FAIL before 6.2 + 7.x complete.
  _Spec: all contacts-crud-api scenarios · Integration_

---

## Phase 7: Wiring and Boot (Slice B)

- [ ] 7.1 Modify `apps/backend/src/app.ts`: extend `buildApp` signature to `buildApp(deps?: AppDeps)` where `AppDeps = { db: DbClient; env: Env }`. When `deps` is present, mount `createContactsRoute(deps)` under `/contacts`. When absent, mount only health (no regression to existing `health.test.ts`).
  _Design: buildApp deps-optional pattern_

- [ ] 7.2 Modify `apps/backend/src/main.ts`: call `loadEnv()`, `createDbClient(env)`, run migration via `client.adminSql` (execute `drizzle/0000_contacts.sql`), then `buildApp({ db: client, env })`. Register `close()` on `SIGTERM`/`SIGINT` (drain connections).
  _Design: main.ts boot sequence_

- [ ] 7.3 **[GREEN]** Verify `contacts.route.int.test.ts` passes (all HTTP status assertions from 6.3).

- [ ] 7.4 **[REFACTOR + final sweep]** Run `pnpm test` (full suite): `health.test.ts`, `env.test.ts`, `tenant.middleware.test.ts`, `result-to-response.test.ts`, `rls.int.test.ts`, `contacts.repository.int.test.ts`, `contacts.route.int.test.ts` all green. Run `pnpm typecheck` + `pnpm lint`. Fix any type or lint errors.

---

## Task Type Legend

- Docker-free: pure Vitest, no container needed
- Integration: requires Testcontainers (PG16); needs Docker Desktop locally or Docker on CI

## Parallelism Notes

- Tasks 1.3, 1.8 are independent of each other and of 1.1–1.2; can run concurrently.
- Tasks within Slice A (Phases 1–3) are sequentially dependent on each other.
- Slice B (Phases 4–7) depends on Slice A being green (env + withTenant + migration available).
- Within Slice B: 4.1 can start once 1.x is done; 5.1 RED test can be written in parallel with 6.1 RED test.
- 7.1 and 7.2 can be written in parallel; both must complete before 7.3 can go GREEN.
