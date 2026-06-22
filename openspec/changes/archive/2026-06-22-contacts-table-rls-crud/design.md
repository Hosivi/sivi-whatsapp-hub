# Design: contacts-table-rls-crud

> SDD phase: design · Store: hybrid (this topic + openspec/changes/2026-06-22-contacts-table-rls-crud/design.md)
> Reads: proposal #2444. All 4 high-level decisions FIXED. This pins the HOW.

## Technical Approach
Bottom-up functional DI. Single non-negotiable invariant: SET LOCAL app.current_tenant runs in the SAME transaction as every contacts query. Enforced structurally via one withTenant(tx-runner) helper that ALL repo ops funnel through — no query reaches Postgres outside a tenant-pinned sql.begin block. RLS lives in migration SQL (reviewable), never app code. Wires into existing Result, normalizePhoneE164, detectPhoneDuplicates; does NOT rebuild them.

## File Changes
| File | Action | Purpose |
|------|--------|---------|
| apps/backend/package.json | Modify | +drizzle-orm, postgres; +dev drizzle-kit, @testcontainers/postgresql |
| apps/backend/drizzle.config.ts | Create | drizzle-kit dialect postgresql, schema glob, out ./drizzle |
| apps/backend/src/config/env.ts | Create | Zod env (DATABASE_URL, AUTH_MODE, PORT, LOG_LEVEL); loadEnv() fail-fast |
| apps/backend/src/db/client.ts | Create | createDbClient(env) → {sql, db} + withTenant helper |
| apps/backend/src/db/schema/contacts.schema.ts | Create | Drizzle contacts table + partial-unique index + indexes |
| apps/backend/drizzle/0000_contacts.sql | Create | Generated DDL + hand-appended RLS block |
| apps/backend/src/contacts/contacts.errors.ts | Create | ContactError union (no throw) |
| apps/backend/src/contacts/contacts.repository.ts | Create | createContactsRepository(db) — ops return Result, NO WHERE tenant_id |
| apps/backend/src/contacts/contacts.route.ts | Create | createContactsRoute(deps) CRUD + resultToResponse mapper |
| apps/backend/src/http/tenant.middleware.ts | Create | createTenantMiddleware(env) — X-Tenant-Id Zod UUID, AUTH_MODE gated |
| apps/backend/src/app.ts | Modify | buildApp(deps?: AppDeps) — contacts mount only when deps present |
| apps/backend/src/main.ts | Modify | loadEnv() → createDbClient → buildApp({db,env}) |
| apps/backend/test/_helpers/test-db.ts | Create | createTestDb() — boot PG16, run migration, seed, truncate() |
| apps/backend/test/contacts/rls.int.test.ts | Create | Cross-tenant invisibility RED→GREEN |
| apps/backend/test/contacts/contacts.repository.int.test.ts | Create | Repo ops under RLS |
| apps/backend/test/contacts/contacts.route.int.test.ts | Create | HTTP CRUD + status mapping |
| compose.yaml, .env.example | Create | Local PG16 + sample env |

Result stays at apps/backend/src/shared/result.ts; contacts module at apps/backend/src/contacts/. NodeNext .js import suffixes throughout. tsconfig excludes test/, so Testcontainers harness lives outside src build.

## Architecture Decisions

### RLS transaction boundary — withTenant is the ONLY path to the DB (make-or-break)
client.ts exports withTenant(tenantId, run); there is NO exported way to query outside it.
```ts
export type DbClient = {
  readonly sql: postgres.Sql; readonly db: PostgresJsDatabase;
  withTenant<T>(tenantId: string, run: (tx: PostgresJsDatabase) => Promise<T>): Promise<T>;
};
export const createDbClient = (env: Env): DbClient => {
  const sql = postgres(env.DATABASE_URL, { max: 10 });
  return { sql, db: drizzle(sql),
    withTenant: (tenantId, run) => sql.begin(async (txSql) => {
      await txSql`SELECT set_config('app.current_tenant', ${tenantId}, true)`; // SET LOCAL, tx-scoped, parameterized
      return run(drizzle(txSql)); // Drizzle bound to SAME tx connection
    }) };
};
```
Alternatives REJECTED: (a) SET LOCAL in middleware on pooled conn → query may land on different conn, isolation silently breaks; (b) conn-per-tenant → no scale; (c) set_config(...,false) session-level → leaks across pooled requests. Rationale: set_config(key,val,true) = parameterized SET LOCAL (no uuid string-interp); txSql-bound Drizzle guarantees same-tx; repo NEVER gets raw db, only withTenant.

### env validation fail-fast
loadEnv() Zod-parses process.env; .parse() throws (infra boundary — allowed) → exit before serving. AUTH_MODE enum ['dev-header','jwt']. PORT/LOG_LEVEL defaulted. Misconfig is infra, not domain Result.

### intent_confidence + updated_at
intent_confidence = numeric(4,3) NULLABLE (0.000–1.000; null=unknown). updated_at = APP-SET in repo per write (updatedAt: new Date()), NOT a DB trigger. Rationale: numeric(4,3) pins precision for tests; nullable (intent may be unset); app-set keeps migration trigger-free + value testable in the returned Result. created_at keeps DB default now().

### tenant middleware (JWT-swap localized)
createTenantMiddleware(env): when AUTH_MODE==='dev-header' reads X-Tenant-Id, validates z.string().uuid(), c.set('tenantId', id). Missing/invalid → 401 JSON (never silent unscoped query). AUTH_MODE==='jwt' → 501 until impl. Routes read c.get('tenantId') → withTenant. Only tenant-source knowledge lives here; JWT swap touches nothing in repo/routes.

### Result→HTTP mapping
resultToResponse(c, result) central mapper. VALIDATION→400, DUPLICATE→409, NOT_FOUND→404, UNAUTHENTICATED→401, default→500. (resolves open Q3)

## Data Flow
HTTP → tenantMiddleware (X-Tenant-Id → c.tenantId | 401) → contacts.route (Zod parse) → repository.op(tenantId, dto) → withTenant(tenantId, tx ⇒ set_config('app.current_tenant'); drizzle(tx).query) → Postgres RLS USING(tenant_id = current_setting(...)::uuid) auto-scope → Result<T,ContactError> → resultToResponse → JSON+status.

## Interfaces
```ts
type ContactsRepository = {
  upsert(tenantId, dto): Promise<Result<Contact, ContactError>>;
  findByPhone(tenantId, phone): Promise<Result<Contact, ContactError>>;
  findById(tenantId, id): Promise<Result<Contact, ContactError>>;
  list(tenantId, opts?): Promise<Result<Contact[], ContactError>>;
  softDelete(tenantId, id): Promise<Result<void, ContactError>>;
};
```
upsert normalizes via normalizePhoneE164 (→VALIDATION on err), then Drizzle onConflictDoUpdate on (tenant_id, phone_e164) WHERE deleted_at IS NULL; conflict on soft-deleted row RESURRECTS (clears deleted_at). list/findByPhone filter deleted_at IS NULL (Q2 resolved). tenant_id NEVER in a WHERE — RLS handles it.

```sql
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
CREATE UNIQUE INDEX contacts_tenant_phone_uq ON contacts (tenant_id, phone_e164) WHERE deleted_at IS NULL;
CREATE INDEX contacts_tenant_created_idx ON contacts (tenant_id, created_at);
```

## Testing Strategy (Strict TDD active)
| Layer | What | Approach |
|-------|------|----------|
| Unit (Docker-free) | normalizePhoneE164, detectPhoneDuplicates, resultToResponse, env Zod parse, middleware header validation | Pure vitest |
| Integration (Testcontainers) | RLS cross-tenant invisibility, repo upsert/dedupe/soft-delete/resurrect, route CRUD codes | PG16 container via shared createTestDb() |

createTestDb(): new PostgreSQLContainer('postgres:16-alpine').start() → run drizzle/0000_contacts.sql → {client, seedTenant(), truncate()}. RED→GREEN: rls.int.test.ts FIRST — seed tenant A+B, assert withTenant(B) sees zero of A's rows; FAILS until policy exists. Needs vitest testTimeout 60000 + hookTimeout 120000. Integration files .int.test.ts; unit .test.ts. Runs Windows dev (Docker Desktop) + GitHub Actions (Docker preinstalled). health.test.ts untouched — buildApp() no-arg mounts only health.

## Migration / Rollout
Pure additive on feat/contacts-table-rls-crud. pnpm drizzle-kit generate → base DDL; RLS block hand-appended (drizzle-kit can't emit policies). Rollback: revert branch or DROP POLICY tenant_isolation ON contacts; DROP TABLE contacts;. Health + pure-domain untouched → Corte 0 cannot break.

## Open Questions
None blocking. Q1/Q2/Q6 resolved (upsert=resurrect-on-soft-deleted; soft-deleted hidden from list/findByPhone; intent_confidence numeric(4,3) nullable). Q3/Q4/Q5 in decisions. list pagination → default (created_at DESC); advanced pagination OUT of scope.
