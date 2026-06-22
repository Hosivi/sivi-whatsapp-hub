# Proposal — contacts-table-rls-crud

> SDD phase: propose · Project: sivi-whatsapp-hub · Artifact store: hybrid (engram topic_key `sdd/contacts-table-rls-crud/proposal` + this file)
> Branch: `feat/contacts-table-rls-crud` off clean `main` (e3e934b) · Depends on: `sdd/contacts-table-rls-crud/explore` (with the premise correction below)
> Extends (delta): `openspec/specs/contacts/spec.md` — does NOT duplicate or contradict it.

## 0. Premise correction (the explore artifact is STALE on this point)

The exploration reported the E.164 normalizer, dedupe detector, and `Result<T,E>` as **missing**, and raised a CRITICAL scope-inflation flag because of it. **That is now RESOLVED.** The `contact-phone-e164-dedupe` slice was completed and merged into `main`. Verified in-tree:

- `apps/backend/src/shared/result.ts` — `Result<T,E>` with `ok`, `err`, `isOk`, `isErr` (all `readonly`). **EXISTS.**
- `apps/backend/src/contacts/phone-e164.ts` — `normalizePhoneE164`, `normalizePhoneBatch`, `detectPhoneDuplicates` + `PhoneNormalizationError`, `NormalizationReport`, `DedupeReport`. **EXISTS.**

**Consequence:** this slice does NOT rebuild any of that. It **wires into** the existing domain code. Three decisions are therefore already CLOSED and out of debate: `Result<T,E>` home is `apps/backend/src/shared/result.ts` (no new package); contacts domain location is the in-app module `apps/backend/src/contacts/` (not `packages/contracts`); the normalizer/dedupe are reused as-is.

## 1. Problem statement

Corte 1 is "Contacts: import + dedupe by `phone_e164` + CRUD + tags + manual intent". The phone-identity foundation exists, but **contacts cannot yet be persisted**. The repo is still a Corte-0 walking skeleton: no database, no Drizzle, no migrations, no RLS, no tenant middleware, no repository, no CRUD routes. Until contacts live in Postgres under tenant isolation, nothing in Corte 1+ (conversations, payments, comprobantes, broadcasts) has a home for its data.

This slice stands up **the project's first data-infrastructure layer** and the **first domain table** behind it. It is foundational beyond its size for one reason: **it sets the RLS-from-commit-1 pattern that every future domain table will copy.** The `contacts` table is the template — `tenant_id` column, `tenant_isolation` policy, `SET LOCAL app.current_tenant` per request, zero `WHERE tenant_id` in application code. Getting this honest and machine-tested NOW prevents a tenant-data-leak class of bugs across the whole platform.

## 2. Scope

### In-scope (this change)
- **Postgres 16 + Drizzle ORM** install and a connection factory (`createDbClient(env)`), env-validated via Zod (`DATABASE_URL`).
- **`contacts` Drizzle table schema** with: `id UUID PK gen_random_uuid()`, `tenant_id UUID NOT NULL`, `phone_e164 TEXT NOT NULL`, `full_name TEXT`, `source TEXT`, `tags TEXT[]`, `intent TEXT`, `intent_confidence NUMERIC`, `created_at/updated_at TIMESTAMPTZ DEFAULT now()`, `deleted_at TIMESTAMPTZ` (soft-delete). Unique on `(tenant_id, phone_e164)` for DB-level dedupe.
- **First SQL migration** (`drizzle-kit generate`) that enables RLS, creates the table, and applies the `tenant_isolation` policy.
- **`tenant_isolation` RLS policy**: `USING (tenant_id = current_setting('app.current_tenant')::uuid)`.
- **Tenant middleware** that resolves the tenant id and runs `SET LOCAL app.current_tenant` per request.
- **Contacts repository** (functional: `createContactsRepository(db)`) → `upsert`, `findByPhone`, `findById`, `list`, `softDelete`. Returns `Result<T,E>`. **Wires into** the existing `normalizePhoneE164` for input normalization. NO `WHERE tenant_id` — relies on RLS.
- **CRUD Hono routes** (`createContactsRoute({ repo })`): `POST /contacts`, `GET /contacts`, `GET /contacts/:id`, `PATCH /contacts/:id`, `DELETE /contacts/:id`.
- **`buildApp(deps)`** migration to accept injected deps without regressing the health test.
- **Integration tests** for RLS + repository against real Postgres (Strict TDD — RLS is machine-tested, not deferred).
- **Docker Compose** (Postgres 16) for local dev + test, `.env.example`.

### Out-of-scope (explicitly deferred)
| Deferred item | Why | Where it lands |
|---|---|---|
| **Real auth / JWT issuance** | No auth subsystem exists; building it here inflates scope and is a separate concern. | Later Corte (Decision 2 picks a dev-mode tenant source now) |
| **Dedupe merge / winner selection** | Detection exists; merge is a business-policy decision needing its own design. | Corte 1 import flow |
| **Bulk contact import endpoint** | This change is CRUD + persistence; batch import composition (normalize→detect→insert) is a follow-up. | Corte 1 import slice |
| **`ContactLead` routing/projection** | The Hub→CRM emit is a separate service/event; the contract already exists. | Corte 1+ routing slice |
| **Web dashboard / UI** | No web app yet. | Corte 1+ |
| **`contactLeadSchema.phone_e164` regex tightening** | Touches the published boundary contract. | Follow-up change |
| **Pagination/filtering beyond basic `list`** | Keep first CRUD minimal; add when a real consumer needs it. | Corte 1+ |

## 3. Capabilities

### New Capabilities
- `tenant-isolation`: the platform-wide RLS pattern — `tenant_id` column, `tenant_isolation` policy, `SET LOCAL app.current_tenant` middleware, the dev-mode tenant source, and the no-`WHERE tenant_id` rule. This is the reusable template every future domain table follows.
- `contacts-persistence`: the `contacts` table schema, migration, the functional repository (`createContactsRepository`), and the wiring of the existing phone normalizer into persistence.
- `contacts-crud-api`: the HTTP surface (`POST/GET/GET:id/PATCH/DELETE /contacts`) and its `buildApp(deps)` wiring.

### Modified Capabilities
- `contacts`: extends `openspec/specs/contacts/spec.md` (pure-domain today) with persistence + RLS + HTTP behavior. **Delta only** — the existing `Result`, normalizer, and dedupe requirements are unchanged and are reused, not redefined.

## 4. Approach

Stand up infrastructure bottom-up, test-first, behind the existing functional-DI pattern. Routes stay thin sub-routers (`createContactsRoute({ repo })`); the repository owns Drizzle queries and returns `Result<T,E>`; the tenant middleware brackets every domain route and pins `app.current_tenant` for the request's transaction so RLS auto-scopes every query. The migration — not application code — is where RLS is turned on and the `tenant_isolation` policy is declared, so the security invariant is deterministic and reviewable in SQL. The existing `normalizePhoneE164` is the single normalization entry point the repository calls before insert/upsert; the `(tenant_id, phone_e164)` unique constraint is the DB backstop for dedupe.

## 5. Key Decisions (the 4 genuinely-open ones, RESOLVED)

### Decision 1 — DB integration test strategy → **Testcontainers** (`@testcontainers/postgresql`)
Spin up a real Postgres 16 container per test suite via a `createTestDb()` helper that boots the container, runs the migration (RLS + policy + table), yields a client, and tears down after the suite. Per-test isolation via `TRUNCATE contacts` (or a transaction-rollback wrapper).
- **Why over pre-started docker-compose:** zero-setup and self-contained — `pnpm test` just works on a Windows dev box and in CI with no "did you `docker compose up` first?" footgun and no cross-run state leak from a long-lived DB. CI (GitHub Actions) runs Docker natively; Windows dev needs Docker Desktop (already required by the Docker-Compose dev dependency, so no new ask). The ~10–30s first-container cost is acceptable for an integration tier that **must** exist — RLS tenant isolation is a security invariant and is machine-tested here, not deferred. (Approach 3 from the explore — deferring RLS tests — is REJECTED: it violates Strict TDD and risks tenant leaks.)
- **Tradeoff accepted:** Docker is a hard test dependency. Mitigation: pure-domain tests (normalizer/dedupe/Result, already in-tree) stay Docker-free and remain the fast bulk of the suite; only the repository/RLS tier needs the container.

### Decision 2 — Tenant source for the middleware → **dev-mode `X-Tenant-Id` header now, real auth deferred**
The middleware reads `X-Tenant-Id` (a UUID), validates it with Zod, and runs `SET LOCAL app.current_tenant`. No `X-Tenant-Id` on a domain route → `400` (or `401`-style) via `Result`-mapped error; never a silent unscoped query.
- **Why over minimal JWT parsing now:** there is no auth subsystem, no token issuer, no signing keys. A header is the **smallest thing that keeps RLS honestly testable today** — integration tests set the header and prove cross-tenant reads return nothing. Introducing JWT now means building/issuing/verifying tokens (jose, key management) — a separate concern that belongs to a later Corte.
- **Guardrail (security):** the `X-Tenant-Id` path MUST be gated to dev/test (env flag, e.g. `AUTH_MODE=dev-header`) so it can NEVER be the production tenant source. The middleware interface is auth-agnostic so swapping to JWT later is a localized change behind the same boundary. Flagged for design.

### Decision 3 — Drizzle pg driver → **`postgres` (postgres.js) via `drizzle-orm/postgres-js`**
- **Why over `pg` (node-postgres):** more ergonomic API, first-class with Drizzle's postgres-js adapter, and clean per-request transaction scoping (`sql.begin`) which is exactly what `SET LOCAL` needs (the setting must live inside the same transaction as the query). One pooled client, simpler `DATABASE_URL` wiring. `pg` is battle-tested but more boilerplate for no benefit at this scale. Same driver powers the drizzle-kit migration path.

### Decision 4 — `buildApp()` signature migration → **`buildApp(deps?: AppDeps)` with optional deps, default-construct when absent**
Change the signature to `buildApp(deps?: AppDeps)` where `AppDeps` carries (at least) the contacts repository / db client. When `deps` is omitted, `buildApp` constructs nothing DB-dependent and mounts only the public health route — so `apps/backend/test/health.test.ts` keeps calling `buildApp()` with **zero changes and no regression**. `main.ts` builds real deps (db client → repository) and passes them in. Contacts routes mount only when their deps are present.
- **Why:** backward-compatible by construction; the health test never touches the DB and must not be forced to. Avoids a Postgres dependency leaking into a liveness test.

## 6. Non-goals / first-slice boundaries

- No real auth / JWT — dev-mode `X-Tenant-Id` only, production-gated.
- No `WHERE tenant_id` anywhere in application code — RLS is the ONLY isolation mechanism (CLAUDE.md footgun rule).
- No Supabase, no Redis — Postgres 16 self-hosted is the only data infra.
- No dedupe merge, no bulk import, no `ContactLead` routing — CRUD + persistence only.
- No rebuild of `Result`, normalizer, or dedupe — wire into the existing in-tree code.
- No web/UI.
- No pagination/advanced filtering beyond a basic `list`.

## 7. Review Workload Forecast

**Per-file line estimate (new/modified):**

| File | Est. lines |
|---|---|
| `package.json` (+ `drizzle-orm`, `postgres`, `drizzle-kit`, `@testcontainers/postgresql`, `zod` env) | ~10 |
| `drizzle.config.ts` | ~20 |
| `src/db/client.ts` (`createDbClient`) | ~40 |
| `src/db/env.ts` (Zod env validation) | ~30 |
| `src/contacts/contacts.schema.ts` (Drizzle table) | ~50 |
| `drizzle/0000_*.sql` (migration: table + RLS + policy) | ~45 |
| `src/shared/tenant-middleware.ts` | ~50 |
| `src/contacts/contacts.repository.ts` | ~110 |
| `src/contacts/contacts.route.ts` (CRUD) | ~110 |
| `src/app.ts` (`buildApp(deps)` migration) | ~25 |
| `src/main.ts` (build real deps) | ~20 |
| `test/contacts/contacts.repository.int.test.ts` (RLS + repo) | ~170 |
| `test/contacts/contacts.route.test.ts` | ~90 |
| `test/helpers/test-db.ts` (`createTestDb`) | ~60 |
| `docker-compose.yml` + `.env.example` | ~35 |
| **Total** | **~865** |

- **Decision needed before apply: Yes**
- **Chained PRs recommended: Yes**
- **400-line budget risk: High** (~865 estimated, ~2.2× budget)

**Recommended first-slice boundary (NOT the final split — flagged for the review-workload gate):**

- **Sub-slice A — infra + isolation bootstrap (~420–480 lines):** Drizzle/postgres/drizzle-kit install, env validation, `createDbClient`, `contacts.schema.ts`, first migration (table + RLS + `tenant_isolation` policy), tenant middleware, `createTestDb` helper, **one RLS integration test proving cross-tenant reads return nothing**, Docker Compose + `.env.example`. `buildApp(deps?)` migration with health test untouched. This slice proves the security invariant end-to-end.
- **Sub-slice B — repository + CRUD API (~380–440 lines):** `createContactsRepository`, repository integration tests (upsert/find/list/soft-delete under RLS, wiring the normalizer), `createContactsRoute` CRUD + route tests, mount into `buildApp`.

Both sub-slices land under ~480 lines. Delivery strategy is `ask-on-risk` → the orchestrator MUST decide chained/stacked PRs vs. `size:exception` at the review-workload gate. **This proposal recommends the A/B split but does NOT finalize it.**

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| RLS policy misconfigured → tenant data leak | Med | RLS is declared in SQL migration (reviewable) and proven by a cross-tenant integration test in Sub-slice A; this is the security gate, not optional. |
| `SET LOCAL` outside the query's transaction → setting lost, query unscoped | Med | postgres.js `sql.begin` brackets `SET LOCAL` + queries in ONE transaction; middleware + repository share the request transaction. Pin in design. |
| Dev-mode `X-Tenant-Id` reaches production | Low | Env-gated (`AUTH_MODE=dev-header`), auth-agnostic middleware boundary, flagged for design; replace with JWT in a later Corte. |
| `buildApp` signature change regresses health test | Low | Optional `deps?` param; `buildApp()` with no args still mounts only health. Health test unchanged. |
| Docker required for tests on Windows/CI | Low | Docker Desktop already needed for Compose dev; pure-domain tests stay Docker-free; only the integration tier needs the container. |
| Single oversized PR overwhelms reviewers | High | A/B sub-slice split recommended; resolved at the review-workload gate before apply. |
| `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` friction with Drizzle types | Low | Already the project's tsconfig norm; repository returns `Result` and guards undefined explicitly. |

## 9. Rollback Plan

Pure-additive change on a feature branch. Rollback = revert the branch / drop the migration. Because no prior table exists, `DROP TABLE contacts` + dropping the policy fully reverses Sub-slice A; Sub-slice B is application code only (no schema). The health route and existing pure-domain code are untouched, so reverting cannot break Corte 0.

## 10. Open questions for spec / design

1. **`upsert` conflict semantics** (spec): on `(tenant_id, phone_e164)` collision, does `upsert` update `full_name`/`tags`/`intent`, or is it insert-or-return-existing? Pin the exact merge behavior.
2. **Soft-delete visibility** (spec): does `list`/`findByPhone` exclude `deleted_at IS NOT NULL` by default? Does `upsert` on a soft-deleted row resurrect it?
3. **Error → HTTP mapping** (design): how do repository `Result` error variants map to status codes (validation `400`, not-found `404`, dedupe-conflict `409`, missing tenant `400/401`)?
4. **`SET LOCAL` transaction boundary** (design): confirm the postgres.js `sql.begin` pattern so middleware-set tenant context and repository queries share one transaction — this is the make-or-break detail for RLS correctness.
5. **`updated_at` trigger vs. app-set** (design): DB trigger on update vs. repository writing `updated_at`. Pick one for consistency.
6. **`intent_confidence` type** (spec): `NUMERIC` precision/scale, and whether it is nullable independent of `intent`.

## 11. Next recommended

`sdd-spec` and `sdd-design` (can run in parallel). Spec turns the table shape, RLS behavior, repository operations, and CRUD contract into testable acceptance criteria (extending `openspec/specs/contacts/spec.md` in delta style). Design pins the `SET LOCAL`/transaction pattern, the tenant-middleware interface, the `buildApp(deps)` wiring, and the error→HTTP mapping.
