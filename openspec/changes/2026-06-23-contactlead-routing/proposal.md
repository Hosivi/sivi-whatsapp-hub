# Proposal: ContactLead Routing — Core + Transactional Outbox

## Intent

The Hub must hand captured WhatsApp contacts to the SiviHub CRM ONLY through the `ContactLead` contract (the frontier rule). Today there is no routing path: no way to mark a contact as routed, and no durable, consumer-ready record of the emitted lead. This slice builds the routing CORE — a pure `Contact → ContactLead` mapper, an atomic `routeContact` service, a `POST /contacts/:id/route` endpoint, and a transactional `contact_lead_outbox` that persists each emitted lead (at-least-once, consumer-ready). No CRM consumer exists yet, so the outbox simply accumulates rows.

## Scope

### In Scope
- `routed_at TIMESTAMPTZ` column on `contacts` (nullable; NULL = not yet routed).
- `contact_lead_outbox` table — a domain table, so `tenant_id` + a `tenant_isolation` RLS policy from commit 1 (hard rule); `payload JSONB`, `status`, timestamps.
- Pure `mapContactToLead(contact): Result<ContactLead, ContactRoutingError>` (unit-testable, no I/O).
- `routeContact` service: ONE `withTenant` transaction that marks `contacts.routed_at` AND inserts the outbox row atomically.
- `POST /contacts/:id/route` endpoint (tenant from `c.get('tenantId')`, reuses `repo.findById`).
- `ContactRoutingError` discriminated union + a Result→HTTP status mapping.
- Migration: NEW `0001_routing.sql` (routed_at + outbox + RLS + GRANT) and a multi-file ordered runner in `migrate.ts` / `test-db.ts`.
- Strict-TDD tests (Testcontainers as `app_rls`): mapping unit, route integration, outbox-write integration, tenant isolation, idempotency.

### Out of Scope (Non-goals)
- **Worker / drain process + pg-boss** → a future `contactlead-routing-worker` change. The outbox persists rows consumer-ready; nothing drains it yet. There is no CRM consumer.
- No CRM HTTP call, no `worker.ts` entrypoint, no `croner`, no auto-routing on intent set, no outbox TTL/monitoring/alerting.

## Decisions (with rationale)

1. **`full_name` null policy** → BLOCK routing with `err({ code: 'MISSING_FULL_NAME' })`. The contract requires `full_name: z.string()` (non-optional). Emitting an empty/phone fallback would push dirty data across the frontier and corrupt CRM dedupe and display. Routing is a deliberate data-quality gate (HTTP 422). _Recommended over the fallback options._
2. **`routed_at` idempotency** → re-routing an already-routed contact is a NO-OP: return a reference to the existing outbox row, do NOT re-emit, do NOT bump `routed_at`. Mirrors the existing `softDelete` idempotency pattern and prevents duplicate leads at the contract boundary. (An explicit `re-route` / re-emit is deferred to a future change if ever needed.)
3. **Migration strategy** → add a NEW `0001_routing.sql` (routed_at `ALTER`, outbox DDL, outbox RLS policy, `GRANT` to `app_rls`); refactor `migrate.ts` and `test-db.ts` to run an ORDERED list of migration files (`['0000_contacts.sql', '0001_routing.sql']`). This avoids the documented drizzle-kit overwrite footgun on `0000`. Each file MUST stay idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS` before create.
4. **Outbox table shape** → a single `payload JSONB` column holding the full ContactLead (validated against `contactLeadSchema` at write time) plus envelope columns: `id uuid PK`, `tenant_id uuid NOT NULL`, `contact_id uuid NOT NULL`, `status text NOT NULL DEFAULT 'pending'`, `created_at timestamptz NOT NULL DEFAULT now()`. JSONB decouples the outbox from contract field churn; the contract Zod schema is the write-time guard.
5. **Worker-tenant pattern (FORWARD CONSTRAINT for the worker slice)** → the eventual worker polls the outbox via `adminSql` (a trusted internal read), then MUST use `withTenant(tenant_id, …)` for ANY domain write (e.g. flipping `status`). Using `adminSql` for domain writes is an RLS footgun and is banned. Documented now so the worker slice inherits the constraint.
6. **Mapping specifics** → `source` always `'whatsapp'`; `captured_at = createdAt.toISOString()`; `intent_confidence` null→undefined; `intent` null→undefined; `tags` passthrough; `form_payload` undefined; `external_id = contact.id`; `tenant_id = contact.tenantId`.

## Capabilities

> This section is the CONTRACT between proposal and specs phases.

### New Capabilities
- `contactlead-routing`: marking a contact as routed and persisting the emitted `ContactLead` into a transactional, tenant-scoped outbox via `POST /contacts/:id/route`.

### Modified Capabilities
- None. No spec-level change to existing contacts CRUD behavior; `routed_at` is additive and read-only to current flows.

## Approach

A pure mapper (`mapContactToLead`) does the `Contact → ContactLead` translation and the `full_name` quality gate, returning `Result<ContactLead, ContactRoutingError>` — fully unit-testable, no I/O. The `routeContact` service composes it: `findById` (404 if absent) → map (422 if `MISSING_FULL_NAME`) → idempotency check on `routed_at` (no-op if already set) → ONE `withTenant` transaction that `UPDATE contacts SET routed_at = now()` AND `INSERT contact_lead_outbox (payload, status='pending', …)` atomically. The endpoint wires it from `c.get('tenantId')`, reusing the existing per-request repo factory. The outbox is a domain table with full RLS (`tenant_isolation`) from commit 1; the routing write runs as `app_rls` inside `withTenant`, so the outbox needs an explicit `GRANT SELECT, INSERT ON contact_lead_outbox TO app_rls`. Throw only at infra (Hono `onError`); `Result<T,E>` everywhere in domain.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/backend/drizzle/0001_routing.sql` | New | routed_at ALTER + outbox table + outbox RLS + GRANT to app_rls |
| `apps/backend/src/db/migrate.ts` | Modified | Multi-file ordered runner (0000, 0001); stays idempotent |
| `apps/backend/test/_helpers/test-db.ts` | Modified | Run ordered migrations; truncate outbox too |
| `apps/backend/src/db/schema/contacts.schema.ts` | Modified | Add `routedAt` column + mapper field |
| `apps/backend/src/db/schema/contact-lead-outbox.schema.ts` | New | Outbox Drizzle table definition |
| `apps/backend/src/contacts/contacts.routing.ts` | New | `mapContactToLead` + `routeContact` service |
| `apps/backend/src/contacts/contacts.routing.errors.ts` | New | `ContactRoutingError` discriminated union |
| `apps/backend/src/contacts/contacts.route.ts` | Modified | `POST /:id/route` handler |
| `apps/backend/test/contacts/contacts.routing.*.test.ts` | New | unit (mapper) + integration (route, outbox, isolation, idempotency) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| drizzle-kit regen erases hand-written RLS in `0001` | Med | Same documented footgun as `0000`; header warning + re-append note in the file |
| Outbox grows unbounded (no consumer yet) | High (by design) | Out-of-scope worker slice owns drain/TTL; documented as a Non-goal |
| Multi-file runner breaks the existing single-file `0000` flow | Low | Ordered array runs `0000` first; idempotent re-run; integration tests cover a fresh DB |
| Missing GRANT on outbox → app_rls INSERT fails at routing | Med | `0001` MUST `GRANT SELECT, INSERT ON contact_lead_outbox TO app_rls` |
| `full_name` gate surprises operators (silent contacts cannot route) | Low | 422 `MISSING_FULL_NAME` is explicit and documented; UI can prompt for a name before routing |

## Rollback Plan

Revert the `0001_routing.sql` file, the multi-file runner change, the new routing module, and the route handler. To undo DB state (additive, no contact data loss):

```sql
DROP TABLE IF EXISTS contact_lead_outbox;
ALTER TABLE contacts DROP COLUMN IF EXISTS routed_at;
```

No production consumer depends on the outbox yet, so dropping it is safe.

## Dependencies

- The `ContactLead` contract (`packages/contracts/src/contact-lead.ts`) — read-only reference; the canonical payload shape and the write-time validation schema.
- Existing `withTenant` / `adminSql` (`apps/backend/src/db/client.ts`) and `repo.findById`.

## Review Workload Forecast

- Estimated changed lines (per-file): `0001_routing.sql` ~45; `migrate.ts` runner refactor ~30; `test-db.ts` ~20; `contacts.schema.ts` ~6; `contact-lead-outbox.schema.ts` ~35; `contacts.routing.ts` (mapper + service) ~90; `contacts.routing.errors.ts` ~12; `contacts.route.ts` ~35; tests ~140. **Total ≈ 410–460 changed lines.**
- **400-line budget risk: Medium**
- **Chained PRs recommended: No** (single cohesive capability; the worker is already a separate future change)
- **Decision needed before apply: Yes** — the diff is borderline ~400. Recommend proceeding as a SINGLE PR with `size:exception`: this is one coherent capability, and splitting the pure mapper from the outbox write would produce a non-shippable half. Confirm `size:exception` at apply time.

## Success Criteria

- [ ] `POST /contacts/:id/route` on a valid, named contact → marks `routed_at` AND inserts exactly one outbox row, atomically, returning success.
- [ ] Routing a contact with NULL `full_name` → 422 `MISSING_FULL_NAME`, no outbox row written, `routed_at` untouched.
- [ ] Re-routing an already-routed contact → no-op: no duplicate outbox row, `routed_at` unchanged.
- [ ] Outbox `payload` validates against `contactLeadSchema`; the `tenant_isolation` RLS policy blocks cross-tenant reads when connected as `app_rls`.
- [ ] Mapper unit tests cover every field translation (source literal `'whatsapp'`, `captured_at` ISO string, null→undefined for intent/confidence, `external_id = id`).
