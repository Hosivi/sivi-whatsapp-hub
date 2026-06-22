# Design: contacts-table-rls-crud

> SDD phase: design · Store: hybrid (engram `sdd/contacts-table-rls-crud/design` + this file)
> Reads: proposal #2444 + the CORRECTED spec (`./spec.md`). All 4 high-level decisions FIXED. This pins the HOW.
> Rev 2 — corrective rework after the adversarial design gate (resolves C1–C6, W1–W3). This file's layout is AUTHORITATIVE; `sdd-tasks` follows THIS, not the proposal.

## Technical Approach

Bottom-up functional DI. The non-negotiable invariant: **`SET LOCAL app.current_tenant` runs in the SAME transaction as every contacts query**, executed by a process that connects as a **non-superuser role** (otherwise RLS is silently bypassed). We enforce the tx-boundary structurally with one `withTenant(tenantId, run)` runner that ALL repository ops funnel through — no query can reach Postgres outside a tenant-pinned `sql.begin` block, and the repository NEVER receives a raw `db`/`sql`. RLS lives in the migration SQL (reviewable), never in app code. We wire into the existing `Result`, `normalizePhoneE164`, `detectPhoneDuplicates`; we do not rebuild them.

## File Changes

| File | Action | Purpose |
|------|--------|---------|
| `apps/backend/package.json` | Modify | +deps `drizzle-orm`, `postgres`; +dev `drizzle-kit`, `@testcontainers/postgresql` |
| `apps/backend/drizzle.config.ts` | Create | drizzle-kit: dialect `postgresql`, schema glob, `out: ./drizzle` |
| `apps/backend/src/config/env.ts` | Create | Zod env schema (`DATABASE_URL`, `DATABASE_ADMIN_URL`, `AUTH_MODE`, `PORT`, `LOG_LEVEL`); `loadEnv()` fail-fast |
| `apps/backend/src/db/client.ts` | Create | `createDbClient(env)` → `{ withTenant, adminSql, close }`. App/repo path exposes ONLY `withTenant`; `adminSql` is the privileged handle used solely for migration/bootstrap |
| `apps/backend/src/db/schema/contacts.schema.ts` | Create | Drizzle `contacts` table + partial-unique index + list index; row→`Contact` mapper (NUMERIC→`number`) |
| `apps/backend/drizzle/0000_contacts.sql` | Create | Generated DDL **plus** hand-appended RLS block + `app_rls` role provisioning + grants |
| `apps/backend/src/contacts/contacts.errors.ts` | Create | `ContactError` union: `CONTACT_NOT_FOUND \| CONTACT_ALREADY_EXISTS \| INVALID_PHONE \| DB_ERROR` (domain errors, no throw) |
| `apps/backend/src/contacts/contacts.repository.ts` | Create | `createContactsRepository(withTenant, tenantId)` — ops return `Result`, NO `WHERE tenant_id`, NO raw `db` |
| `apps/backend/src/contacts/contacts.route.ts` | Create | `createContactsRoute(deps)` — CRUD sub-router + `resultToResponse` mapper |
| `apps/backend/src/http/tenant.middleware.ts` | Create | `createTenantMiddleware(env)` — `X-Tenant-Id` Zod UUID, `AUTH_MODE` gated |
| `apps/backend/src/app.ts` | Modify | `buildApp(deps?: AppDeps)` — optional deps; contacts mount only when present |
| `apps/backend/src/main.ts` | Modify | `loadEnv()` → `createDbClient` → run migration via `adminSql` → `buildApp({ db, env })` |
| `apps/backend/test/_helpers/test-db.ts` | Create | `createTestDb()` — boot PG16, migrate as superuser, provision `app_rls`, expose an `app_rls`-scoped client + `seedTenant()` + `truncate()` |
| `apps/backend/test/contacts/rls.int.test.ts` | Create | Cross-tenant invisibility + WITH CHECK + app-role enforcement (RED→GREEN) |
| `apps/backend/test/contacts/contacts.repository.int.test.ts` | Create | Repo ops under RLS (create/conflict/resurrect/update/soft-delete) |
| `apps/backend/test/contacts/contacts.route.int.test.ts` | Create | HTTP CRUD + Result→status mapping |
| `compose.yaml`, `.env.example` | Create | Local PG16 + sample env (both `DATABASE_URL` as `app_rls` and `DATABASE_ADMIN_URL`) |

`Result` stays at `apps/backend/src/shared/result.ts`; contacts module stays at `apps/backend/src/contacts/`. NodeNext `.js` import suffixes throughout.

## Architecture Decisions

### Decision: RLS transaction boundary — `withTenant` is the only path to the DB (C-boundary, W1)
**Choice**: `client.ts` exports a `withTenant(tenantId, run)` runner. The repository factory receives ONLY this runner (not `db`/`sql`), so there is no in-repo way to query outside a tenant-pinned tx. The privileged `adminSql` handle exists solely for migration/bootstrap in `main.ts`/tests and is never handed to a repository.

```ts
// db/client.ts
export type TenantRunner = <T>(tenantId: string, run: (tx: PostgresJsDatabase) => Promise<T>) => Promise<T>;
export type DbClient = {
  readonly withTenant: TenantRunner;   // the ONLY path repositories receive
  readonly adminSql: postgres.Sql;     // privileged; migration/bootstrap ONLY (main.ts / tests)
  close(): Promise<void>;
};
export const createDbClient = (env: Env): DbClient => {
  const sql = postgres(env.DATABASE_URL, { max: 10 }); // connects as the non-superuser app_rls role
  const withTenant: TenantRunner = (tenantId, run) =>
    sql.begin(async (txSql) => {
      // set_config(key, val, true) === SET LOCAL — tx-scoped, resets at COMMIT/ROLLBACK, parameterized (no uuid string-interp)
      await txSql`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return run(drizzle(txSql)); // Drizzle bound to the SAME reserved tx connection
    });
  const adminSql = postgres(env.DATABASE_ADMIN_URL, { max: 2 });
  return { withTenant, adminSql, close: async () => { await sql.end(); await adminSql.end(); } };
};
```
**Alternatives**: (a) `SET LOCAL` in middleware on a pooled conn — REJECTED: postgres.js pools, the query may land on a different conn, isolation silently breaks. (b) Connection-per-tenant — REJECTED: doesn't scale. (c) `set_config(..., false)` session-level — REJECTED: leaks across pooled requests. (d) exposing raw `db` to repos — REJECTED (W1): an unscoped `db.select(...)` would bypass `withTenant`; the repo gets only `withTenant`.
**Rationale**: `set_config(key, val, true)` is the parameterized form of `SET LOCAL`; the `txSql`-bound Drizzle guarantees same-tx. Make-it-impossible-to-get-wrong satisfied structurally.

### Decision: non-superuser application role — `app_rls` (C1, the silent-bypass killer)
**Choice**: Postgres RLS is **bypassed entirely by superusers** and (without `FORCE`) by the table owner. `postgres:16-alpine` defaults to a superuser, so connecting the app as the default role would disable RLS in production AND let integration tests pass misleadingly. Therefore:
1. The migration/bootstrap (run via `adminSql`, privileged) provisions a dedicated role:
   `CREATE ROLE app_rls LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`
   and grants the minimum: `GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_rls;` (plus `USAGE` on the schema).
2. The app runtime `DATABASE_URL` connects **as `app_rls`**. `DATABASE_ADMIN_URL` (superuser/owner) is used ONLY to run migrations.
3. `createTestDb()` runs the migration as the container superuser, then **opens the assertion client as `app_rls`** and runs all RLS/repo/route tests through it. A negative-control note documents that the superuser would bypass RLS — proving the test actually exercises the role boundary.
**Rationale**: `FORCE ROW LEVEL SECURITY` closes only the table-owner hole; the role separation closes the superuser hole. Both are required for RLS to be real.

### Decision: env validation fail-fast at startup
**Choice**: `loadEnv()` parses `process.env` with Zod; `.parse()` throws (infra boundary — allowed) → process exits before serving. `DATABASE_URL` (app_rls) and `DATABASE_ADMIN_URL` required. `AUTH_MODE` enum `['dev-header','jwt']`. `PORT`/`LOG_LEVEL` defaulted.
**Rationale**: misconfig is an infra failure, not a domain `Result`. Throwing here is correct per hard rules.

### Decision: `intent_confidence` + `updated_at` (C6, W2)
**Choice**: `intent_confidence` = `NUMERIC(5,4)` **nullable** with `CHECK (intent_confidence >= 0 AND intent_confidence <= 1)` (matches the spec exactly; `null` = unknown). `updated_at` = **app-set in the repository** on each write (`updatedAt: new Date()`), NOT a DB trigger; `created_at` = DB `default now()`.
**NUMERIC→number boundary (W2)**: postgres.js/Drizzle return `NUMERIC` as a **string** by default. The `contacts.schema.ts` row→`Contact` mapper MUST convert `intent_confidence` via `value === null ? null : Number(value)` so the domain `Contact.intentConfidence` is `number | null`. A repository integration test asserts the returned value is `typeof === 'number'` (not a string).
**Rationale**: pins precision deterministically for tests, enforces the 0–1 domain invariant at the DB, and prevents the silent string-vs-number type mismatch.

### Decision: tenant middleware boundary — split statuses (C5; JWT-swap localized)
**Choice**: `createTenantMiddleware(env)` returns a Hono middleware. When `AUTH_MODE==='dev-header'`: read `X-Tenant-Id`; **missing header → `401` `{ "error": "MISSING_TENANT" }`**; **present but not a UUID (`z.string().uuid()` fails) → `400` `{ "error": "INVALID_TENANT_ID" }`**; valid → `c.set('tenantId', id)`. When `AUTH_MODE==='jwt'` → `501` until implemented. Routes read `c.get('tenantId')` and build a tenant-scoped repo. A request NEVER reaches a query without a validated tenant.
**Rationale**: the only tenant-source knowledge lives in this one file; swapping to JWT touches nothing in the repo/routes. Distinct 401/400 matches the spec's middleware scenarios.

### Decision: Result→HTTP mapping (C4)
**Choice**: `resultToResponse(c, result)` central mapper for `ContactError` → status:
`INVALID_PHONE → 422`, `CONTACT_ALREADY_EXISTS → 409`, `CONTACT_NOT_FOUND → 404`, `DB_ERROR → 500`.
HTTP-layer errors handled OUTSIDE `ContactError` (before/around the repo call): Zod **body** validation failure → `400` `{ "error": "VALIDATION_ERROR" }`; `MISSING_TENANT → 401`; `INVALID_TENANT_ID → 400` (both from the middleware).
**Rationale**: `INVALID_PHONE` is a 422 (semantically valid JSON, unprocessable value) distinct from a 400 malformed-body — matches the spec's dedicated scenarios. One table; routes stay declarative.

## Data Flow

```
HTTP req ──▶ tenantMiddleware
              ├─ missing X-Tenant-Id      → 401 MISSING_TENANT
              ├─ non-UUID X-Tenant-Id     → 400 INVALID_TENANT_ID
              └─ valid → c.set('tenantId')
        ──▶ contacts.route (parse body via Zod → 400 VALIDATION_ERROR on fail)
              └─ repo = createContactsRepository(db.withTenant, c.get('tenantId'))
        ──▶ repo.op(dto)                       (single-arg; tenant is implicit/session-bound)
              └─ withTenant(tenantId, tx ⇒ set_config('app.current_tenant',·,true) ; drizzle(tx).query)
                    └─ Postgres RLS USING/WITH CHECK (tenant_id = current_setting(...)::uuid)  ← auto-scope
        ◀── Result<T, ContactError> ──▶ resultToResponse ──▶ JSON + status
```

## Interfaces

```ts
// contacts.repository.ts — signatures MATCH the spec: single-arg, tenant implicit (no tenantId param, no WHERE tenant_id)
type ContactsRepository = {
  create(input: NewContactInput): Promise<Result<Contact, ContactError>>;
  findById(id: string): Promise<Result<Contact, ContactError>>;
  list(opts?: ListOpts): Promise<Result<Contact[], ContactError>>;
  update(id: string, patch: ContactPatch): Promise<Result<Contact, ContactError>>;
  softDelete(id: string): Promise<Result<void, ContactError>>;
};
// Per-request, tenant-scoped construction in the route handler:
//   const repo = createContactsRepository(db.withTenant, c.get('tenantId'));
// The factory closes over (withTenant, tenantId); every op runs inside withTenant(tenantId, …). No raw db, ever.
export const createContactsRepository = (withTenant: TenantRunner, tenantId: string): ContactsRepository => { /* … */ };
```

### `create` — conflict + resurrect (C3: explicit read-then-branch, NOT ON CONFLICT)
A partial unique index `WHERE deleted_at IS NULL` does **not** contain soft-deleted rows, so `INSERT … ON CONFLICT` can never match (and would resurrect) them — it would insert a duplicate. Therefore `create` is an explicit branch inside one `withTenant` tx:
1. `normalizePhoneE164(input.phone)` → on `err` return `err(INVALID_PHONE)` (no DB hit).
2. `SELECT * FROM contacts WHERE phone_e164 = $1 LIMIT 1` (RLS scopes to tenant; includes soft-deleted rows — NO `deleted_at` filter here).
3. row exists AND `deleted_at IS NULL` (live) → `err(CONTACT_ALREADY_EXISTS)` (409 — never overwrite).
4. row exists AND `deleted_at IS NOT NULL` (soft-deleted) → `UPDATE … SET deleted_at = NULL, full_name = …, source = …, tags = …, intent = …, intent_confidence = …, updated_at = $now RETURNING *` → **resurrect, SAME id** → `ok(contact)`.
5. else → `INSERT … RETURNING *`. Wrap in a `catch` on unique-violation `23505` → `err(CONTACT_ALREADY_EXISTS)`, which makes the concurrent-create race (two new-phone inserts) deterministic.
The partial unique index `contacts_tenant_phone_uq` remains the backstop for **live** uniqueness only.

### `softDelete` — idempotency by existence read (W3)
Inside `withTenant`: `SELECT id, deleted_at FROM contacts WHERE id = $1` (RLS-scoped; no `deleted_at` filter).
- no row → `err(CONTACT_NOT_FOUND)`.
- row, `deleted_at IS NOT NULL` (already deleted) → `ok(undefined)` (idempotent).
- row, live → `UPDATE … SET deleted_at = now() WHERE id = $1` → `ok(undefined)`.
Distinguishing "already deleted" from "absent" requires the existence read — rowcount alone (`… WHERE deleted_at IS NULL`) cannot tell them apart.

`findById`/`list` filter `deleted_at IS NULL` (soft-deleted hidden); `list` orders `created_at DESC`. `tenant_id` is NEVER in a WHERE — RLS handles it.

```sql
-- drizzle/0000_contacts.sql (RLS + role tail, hand-appended; drizzle-kit can't emit policies/roles)
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;   -- closes the table-OWNER bypass
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
-- non-superuser app role (closes the SUPERUSER bypass) — run via the privileged admin connection
CREATE ROLE app_rls LOGIN PASSWORD :'app_rls_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_rls;
```
Partial unique index: `CREATE UNIQUE INDEX contacts_tenant_phone_uq ON contacts (tenant_id, phone_e164) WHERE deleted_at IS NULL;` plus `CREATE INDEX contacts_tenant_created_idx ON contacts (tenant_id, created_at);` for list.

## Testing Strategy (Strict TDD active)

| Layer | What | Approach |
|-------|------|----------|
| Unit (Docker-free) | `normalizePhoneE164`, `detectPhoneDuplicates`, `resultToResponse` mapping (incl. `INVALID_PHONE`→422), env Zod parse, middleware header validation (missing→401 / non-UUID→400) | Pure vitest, no container |
| Integration (Testcontainers, connected AS `app_rls`) | RLS cross-tenant SELECT/UPDATE/DELETE invisibility, WITH CHECK blocks foreign-tenant INSERT, app-role enforcement, repo create/conflict-409/resurrect-same-id/update/soft-delete-idempotency, NUMERIC→`number`, route CRUD status codes | PG16 container via shared `createTestDb()` |

`createTestDb()`: `new PostgreSQLContainer('postgres:16-alpine').start()` → run `drizzle/0000_contacts.sql` via the **superuser** connection (creates table, policy, `app_rls`, grants) → return `{ client /* connected AS app_rls */, seedTenant(), truncate() }`. RED→GREEN: write `rls.int.test.ts` first — seed tenant A + tenant B, assert `withTenant(B)` sees zero of A's rows, AND assert an INSERT with a foreign `tenant_id` is rejected by `WITH CHECK`; both FAIL until policy + role exist. Container boot needs `testTimeout: 60_000` + `hookTimeout: 120_000` in `vitest.config.ts`. Integration files use `.int.test.ts`; pure unit tests use `.test.ts`. Runs on Windows dev (Docker Desktop) and GitHub Actions (Docker preinstalled). `health.test.ts` stays untouched — `buildApp()` no-arg path mounts only health.

## Migration / Rollout

Pure additive on `feat/contacts-table-rls-crud`. `pnpm drizzle-kit generate` produces base DDL; the RLS + `app_rls` block is hand-appended (drizzle-kit emits neither policies nor roles). Migration runs via `DATABASE_ADMIN_URL` (privileged); the app serves via `DATABASE_URL` (`app_rls`). Rollback: revert branch, or `DROP POLICY tenant_isolation ON contacts; DROP TABLE contacts; DROP ROLE app_rls;`. Health + pure-domain untouched → Corte 0 cannot break.

## Open Questions

- None blocking. Resolved: create conflict = 409-on-live / resurrect-on-soft-deleted via explicit read-then-branch (C3); soft-delete idempotency via existence read (W3); `intent_confidence NUMERIC(5,4)` + CHECK 0–1, mapped to `number` (C6/W2); statuses split (C4/C5); `app_rls` non-superuser role (C1); repo signatures conform to spec (C2); `withTenant`-only DB access (W1). Advanced `list` pagination is OUT of scope (default `created_at DESC` only).
