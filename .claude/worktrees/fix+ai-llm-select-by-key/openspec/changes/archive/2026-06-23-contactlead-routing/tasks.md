# Tasks: ContactLead Routing — Core + Transactional Outbox

> Change: `contactlead-routing` | TDD: Strict RED→GREEN | Store: hybrid

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 420–480 (new files + modifications) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: migration + schema + infra → PR 2: service + mapper + tests + route |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 — Foundation | `0001_routing.sql` + Drizzle schema changes + test-db updates | PR 1 | No new business logic; base all subsequent PR work on this |
| 2 — Logic + Tests + Route | mapper, service (corrected atomicity), all tests, HTTP handler, spec reconciliation | PR 2 | Targets PR 1 branch (feature-branch-chain) or main (stacked-to-main) |

---

## Phase 1: Migration + Schema Infrastructure

- [x] 1.1 **[RED]** Write `test/db/migrate.int.test.ts` assertion: after applying `['0000_contacts.sql', '0001_routing.sql']`, `contact_lead_outbox` exists with all 6 columns, RLS is ENABLED + FORCED, `app_rls` has SELECT+INSERT grants, and `contacts.routed_at` column exists. Run → RED (0001 file missing).
- [x] 1.2 Create `apps/backend/drizzle/0001_routing.sql`: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS routed_at timestamptz`; `CREATE TABLE IF NOT EXISTS contact_lead_outbox (id uuid PK, tenant_id uuid NOT NULL, contact_id uuid NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now())`; `ENABLE/FORCE ROW LEVEL SECURITY`; `DROP POLICY IF EXISTS tenant_isolation ... CREATE POLICY tenant_isolation` (NULLIF pattern matching 0000); `GRANT SELECT, INSERT ON contact_lead_outbox TO app_rls`. Add drizzle-kit regeneration WARNING header. Run test → GREEN.
- [x] 1.3 Modify `apps/backend/src/db/migrate.ts`: replace `MIGRATION_SQL_PATH` constant with `MIGRATION_FILES = ['0000_contacts.sql', '0001_routing.sql'] as const` + `MIGRATIONS_DIR`; replace single-read with `for (const file of MIGRATION_FILES)` loop, applying `makeIdempotent` to each. Remove unused `MIGRATION_SQL_PATH` constant.
- [x] 1.4 Modify `apps/backend/src/db/schema/contacts.schema.ts`: add `routedAt: timestamp('routed_at', { withTimezone: true, mode: 'date' })` to `contactsTable` (after `deletedAt`); add `readonly routedAt: Date | null` to `Contact` type; add `routedAt: row.routedAt ?? null` to `mapRowToContact`.
- [x] 1.5 Create `apps/backend/src/db/schema/contact-lead-outbox.schema.ts`: export `contactLeadOutboxTable` via `pgTable('contact_lead_outbox', { id, tenantId, contactId, payload: jsonb.$type<ContactLead>().notNull(), status, createdAt })`. No FK to contacts (by design ADR-6).
- [x] 1.6 Modify `apps/backend/test/_helpers/test-db.ts`: replace single-file path with `MIGRATION_FILES = ['0000_contacts.sql', '0001_routing.sql']` loop (raw SQL, no `makeIdempotent`); update `truncate()` to `TRUNCATE TABLE contact_lead_outbox, contacts RESTART IDENTITY CASCADE`; extend `seedTenant` `data` param with optional `routedAt?: Date | null` and `fullName` already nullable; add import for `contactLeadOutboxTable` for test assertion helpers.
- [x] 1.7 Run `tsc --noEmit` + `biome check` on changed files — fix all type and lint errors before proceeding.

---

## Phase 2: Error Type + Pure Mapper

- [x] 2.1 Create `apps/backend/src/contacts/contacts.routing.errors.ts`: export `ContactRoutingError = { readonly code: 'CONTACT_NOT_FOUND' } | { readonly code: 'MISSING_FULL_NAME' } | { readonly code: 'DB_ERROR'; readonly cause?: unknown }`.
- [x] 2.2 **[RED]** Create `apps/backend/test/contacts/contacts.routing.map.test.ts` with three unit test cases (Docker-free):
  - Given fully-populated `Contact` (fullName non-null, intent='buy', intentConfidence=0.9, tags=['vip']) → every ContactLead field matches mapping table; `contactLeadSchema.safeParse(lead).success === true`; `form_payload === undefined`.
  - Given `intent: null`, `intentConfidence: null` → `intent` and `intent_confidence` are `undefined` (not null).
  - Given `tags: []` → `tags: []`.
  - Test receives a mapped `Contact` object (not a raw DB row). Run → RED (mapper file missing).
- [x] 2.3 Create `apps/backend/src/contacts/contacts.routing.ts` (mapper only, no service yet): export `mapContactToContactLead(contact: Contact, tenantId: string): ContactLead` — total function, `full_name: contact.fullName as string`, `intent: contact.intent ?? undefined`, `intent_confidence: contact.intentConfidence ?? undefined`, `form_payload: undefined`, `captured_at: contact.createdAt.toISOString()`, `tenant_id: tenantId`. Run mapper tests → GREEN.

---

## Phase 3: `routeContact` Service + Atomicity Tests

- [x] 3.1 **[RED]** Create `apps/backend/test/contacts/contacts.routing.int.test.ts` — integration suite using `createTestDb()` (shared container). Write all 7 scenarios as failing tests:
  1. Happy path: seed named contact → `routeContact` → `ok(lead)`; `contactLeadSchema` validates; `routed_at` set in DB; exactly ONE outbox row, `status='pending'`, `payload` deep-equals `lead`.
  2. Not found: random UUID → `err({ code: 'CONTACT_NOT_FOUND' })`; zero outbox rows.
  3. Soft-deleted = not found: seed + soft-delete → `err({ code: 'CONTACT_NOT_FOUND' })`; zero outbox rows.
  4. Null full_name: seed with `fullName: null` → `err({ code: 'MISSING_FULL_NAME' })`; zero outbox rows; `routed_at` still null.
  5. No-op idempotency: route once; route again → `ok(lead)`; still exactly ONE outbox row; `routed_at` timestamp unchanged.
  6. Tenant isolation: seed contacts for tenant A and B; route A's contact; query outbox as tenant B → zero rows (RLS); route B's id under tenant A → `CONTACT_NOT_FOUND`.
  7. **[MANDATORY] Negative atomicity**: seed eligible contact; force outbox INSERT to fail via a NOT NULL constraint violation on `payload` (pass `null` via a crafted raw SQL override or by temporarily violating schema); assert `routed_at` remains null AND zero outbox rows exist after the error — both writes rolled back together.
  Run all → RED.
- [x] 3.2 Add `routeContact(withTenant: TenantRunner, tenantId: string, contactId: string): Promise<Result<ContactLead, ContactRoutingError>>` to `contacts.routing.ts`:
  - **Outer try/catch wraps the entire `withTenant(...)` call** — maps thrown infra errors to `err({ code: 'DB_ERROR', cause: e })`.
  - Inside the `withTenant` callback (no try/catch here): SELECT contact via `tx`, check `row` / `deletedAt` → return `err(CONTACT_NOT_FOUND)`; check `row.routedAt !== null` → return `ok(mapContactToContactLead(...))`; check `contact.fullName === null` → return `err(MISSING_FULL_NAME)`; UPDATE `routed_at` + INSERT outbox — **let errors propagate** so the transaction rolls back atomically; return `ok(lead)`.
  - Imports: `eq` from `drizzle-orm`; `TenantRunner` from `../db/client.js`; `contactsTable`, `mapRowToContact` from `../db/schema/contacts.schema.js`; `contactLeadOutboxTable` from `../db/schema/contact-lead-outbox.schema.js`; `contactLeadSchema` from `@sivihub/contracts`; `Result`/`ok`/`err` from `../shared/result.js`.
  - Note: pure `Result` branches (not-found / missing-full-name / no-op) return normally; only the write block lets DB throws escape to the outer catch.
  Run integration tests → GREEN.

---

## Phase 4: HTTP Route Handler

- [x] 4.1 **[RED]** Add HTTP-layer test cases to `contacts.routing.int.test.ts` (or create `contacts.routing.route.test.ts`): drive `POST /contacts/:id/route` through the Hono app with `X-Tenant-Id`; assert 200+`{ routed }` (happy path + no-op), 404+`{ error: 'CONTACT_NOT_FOUND' }`, 422+`{ error: 'MISSING_FULL_NAME' }`. Run → RED (route not registered).
- [x] 4.2 Modify `apps/backend/src/contacts/contacts.route.ts`:
  - Add imports: `routeContact` from `./contacts.routing.js`; `ContactRoutingError` type from `./contacts.routing.errors.js`.
  - Add local `routingErrorToHttpStatus(error: ContactRoutingError): 404 | 422 | 500` — exhaustive switch over 3 codes (literal return types, NOT `number`).
  - Register `router.post('/:id/route', ...)` handler BEFORE the existing `router.get('/:id')` and `router.patch('/:id')` handlers: get `id = c.req.param('id')`, `tenantId = c.get('tenantId')`; call `routeContact(deps.db.withTenant, tenantId, id)`; map `!result.ok` → `c.json({ error: result.error.code === 'DB_ERROR' ? 'INTERNAL_ERROR' : result.error.code }, status)` (status from `routingErrorToHttpStatus`); success → `c.json({ routed: result.value }, 200 as const)`.
  - `c.json(body, status)` status must be a literal (`200 as const`, `404 as const`, etc.) — not a generic number.
  Run HTTP tests → GREEN.

---

## Phase 5: Spec Reconciliation + Static Analysis

- [x] 5.1 Update `openspec/changes/2026-06-23-contactlead-routing/spec.md`: reconcile the stale `routeContact(id, repo, db)` signature in the "Requirement: routeContact Service" section to match the canonical design signature `routeContact(withTenant: TenantRunner, tenantId: string, contactId: string)`. Note that the service performs the SELECT directly in the same tx (not via `repo.findById`) — this is ADR-3. No behavior change; spec language only.
- [x] 5.2 Run `tsc --noEmit` across `apps/backend` — fix any type errors introduced (especially `exactOptionalPropertyTypes` — optional fields from Zod output may need `| undefined`; `routedAt` null-coercion in mapper).
- [x] 5.3 Run `biome check --write apps/backend/src apps/backend/test` — fix all lint/format issues.
- [x] 5.4 Run `pnpm test` from repo root — confirm all tests GREEN; confirm no regression in existing contacts tests.
