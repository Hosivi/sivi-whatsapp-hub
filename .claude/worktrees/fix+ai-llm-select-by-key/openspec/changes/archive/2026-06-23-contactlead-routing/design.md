# Design: ContactLead Routing — Core + Transactional Outbox

Status: design
Change: `contactlead-routing`
Conforms to: proposal `sdd/contactlead-routing/proposal` + canonical contract (below).
Layer: backend domain slice. No web, no worker, no Meta. Postgres-only, RLS from commit 1.

---

## 1. Architecture approach

This slice adds a **routing service** alongside the existing contacts CRUD, plus a **transactional outbox**. It keeps the established functional-DI + `Result<T,E>` + `withTenant`-only conventions of the contacts module. No new infrastructure, no container, no classes.

Pattern: **Transactional Outbox**. The state change (`contacts.routed_at`) and the integration record (`contact_lead_outbox` row) are committed in the SAME database transaction, so an emitted lead is durable iff the contact is marked routed — no dual-write gap. No CRM consumer exists yet (out of scope), so the outbox only accumulates rows; a future `contactlead-routing-worker` change owns the drain.

Boundaries (Screaming/Hexagonal-flavored, matching the existing module):
- **Pure core** — `mapContactToContactLead(contact, tenantId)`: total function, no I/O, no Result. Given a `Contact` + tenantId it returns a `ContactLead`. The `full_name` quality gate (422) is enforced in the SERVICE before mapping, not inside the pure mapper, so the mapper stays total and trivially unit-testable against `contactLeadSchema`.
- **Service** — `routeContact(withTenant, tenantId, contactId)`: the only place that touches the DB. ONE `withTenant` tx: read contact → branch → (no-op | set routed_at + insert outbox). Returns `Result<ContactLead, ContactRoutingError>`.
- **HTTP** — `POST /contacts/:id/route` inline in `contacts.route.ts`, maps `Result` → HTTP.
- **Persistence** — new Drizzle table `contact_lead_outbox`; `routed_at` column added to `contacts`; new `0001_routing.sql` migration; multi-file ordered runner.

Why a dedicated `routeContact` service instead of `repo.findById` + a separate insert: the proposal mentioned reusing `repo.findById`, but `findById` opens its OWN `withTenant` tx and commits before any write. The canonical contract demands the read-then-branch-then-write be ATOMIC in ONE transaction (so an already-routed check and the routed_at+outbox write cannot race or partially commit). Therefore `routeContact` does the SELECT itself inside the same tx as the writes. This is an ADR-level correction of the proposal — recorded in §6 (ADR-3).

---

## 2. Component map

| Component | File | Kind | Responsibility |
|-----------|------|------|----------------|
| `mapContactToContactLead` | `apps/backend/src/contacts/contacts.routing.ts` | New (pure) | `Contact` + tenantId → `ContactLead` (field mapping only) |
| `routeContact` | `apps/backend/src/contacts/contacts.routing.ts` | New (service) | atomic read+branch+write inside one `withTenant` tx |
| `ContactRoutingError` | `apps/backend/src/contacts/contacts.routing.errors.ts` | New | `CONTACT_NOT_FOUND \| MISSING_FULL_NAME \| DB_ERROR` union |
| `contactLeadOutboxTable` | `apps/backend/src/db/schema/contact-lead-outbox.schema.ts` | New | Drizzle table for the outbox |
| `routedAt` column + mapper | `apps/backend/src/db/schema/contacts.schema.ts` | Modify | add `routed_at` to table, `Contact`, `mapRowToContact` |
| `POST /:id/route` handler | `apps/backend/src/contacts/contacts.route.ts` | Modify | parse `:id`, call service, map Result→HTTP |
| `routingErrorToHttpStatus` | `apps/backend/src/contacts/contacts.route.ts` | New (local) | `CONTACT_NOT_FOUND`→404, `MISSING_FULL_NAME`→422, `DB_ERROR`→500 |
| `0001_routing.sql` | `apps/backend/drizzle/0001_routing.sql` | New | `routed_at` ALTER + outbox DDL + outbox RLS + GRANT |
| Multi-file runner | `apps/backend/src/db/migrate.ts` | Modify | ordered `[0000, 0001]`, each idempotent, applied in order |
| Test migration runner | `apps/backend/test/_helpers/test-db.ts` | Modify | run both files on fresh container; truncate outbox too |
| Tests | `apps/backend/test/contacts/contacts.routing.*.test.ts` | New | unit (mapper) + integration (7 scenarios) |

---

## 3. Data flow

```
POST /contacts/:id/route
        │  X-Tenant-Id (uuid)  →  tenant.middleware  →  c.set('tenantId')
        ▼
contacts.route.ts handler
        │  id = c.req.param('id');  tenantId = c.get('tenantId')
        ▼
routeContact(deps.db.withTenant, tenantId, id)
        │
        ▼  withTenant(tenantId, tx => { … })   ── ONE transaction ──┐
        │  set_config('app.current_tenant', tenantId, true)         │
        │                                                           │
        │  1. SELECT * FROM contacts WHERE id = :id LIMIT 1         │  (RLS-scoped, NO WHERE tenant_id)
        │       row missing OR deleted_at != null  → return err(CONTACT_NOT_FOUND)   → 404
        │  2. row.routedAt != null  → NO-OP:                        │
        │       lead = mapContactToContactLead(mapRow(row), tenant) │
        │       return ok(lead)   (NO routed_at bump, NO 2nd outbox row) → 200
        │  3. row.fullName == null  → return err(MISSING_FULL_NAME) → 422
        │  4. else (live, unrouted, named):                          │
        │       lead = mapContactToContactLead(mapRow(row), tenant) │
        │       UPDATE contacts SET routed_at = now(), updated_at=now() WHERE id=:id  │
        │       INSERT INTO contact_lead_outbox (tenant_id, contact_id, payload) VALUES (…, lead) │
        │       return ok(lead)                                      │  → 200 { routed: lead }
        └───────────────── COMMIT (atomic) ────────────────────────┘
        ▼
Result → HTTP
   ok(lead)                 → 200 { routed: lead }
   err(CONTACT_NOT_FOUND)   → 404 { error: 'CONTACT_NOT_FOUND' }
   err(MISSING_FULL_NAME)   → 422 { error: 'MISSING_FULL_NAME' }
   err(DB_ERROR)            → 500 { error: 'INTERNAL_ERROR' }
```

**Atomicity guarantee.** Steps 1–4 all run inside the single transaction opened by `withTenant`. `withTenant` (`db/client.ts`) does `db.transaction(async tx => { SELECT set_config(...); return run(tx); })`. Both writes in step 4 use that same `tx` handle, so they commit together or roll back together. If the outbox INSERT throws (e.g. unexpected), the `routed_at` UPDATE in the same tx is never committed — no half-routed state, no orphan. There is exactly ONE `routed_at` set and ONE outbox row per successful first-time route.

**No-op guarantee.** Step 2 returns before any write, so re-routing never bumps `routed_at` and never inserts a second outbox row — mirrors `softDelete` idempotency.

---

## 4. Detailed component design

### 4.1 `ContactRoutingError` (`contacts.routing.errors.ts`)

```ts
export type ContactRoutingError =
  | { readonly code: 'CONTACT_NOT_FOUND' }
  | { readonly code: 'MISSING_FULL_NAME' }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };
```

Kept separate from `ContactError` so the routing surface stays minimal and the HTTP mapper is exhaustive over exactly these three codes. `CONTACT_ALREADY_EXISTS`/`INVALID_PHONE` are irrelevant to routing.

### 4.2 Pure mapper `mapContactToContactLead` (`contacts.routing.ts`)

Total function. Caller (the service) has already guaranteed `fullName` is non-null before calling it, so the mapper takes a `Contact` whose `fullName` is known to be a string at call time and asserts it. To keep the mapper honest and unit-testable in isolation, it accepts the `Contact` and `tenantId` and maps the contract fields per the canonical mapping:

```ts
import type { ContactLead } from '@sivihub/contracts';
import type { Contact } from '../db/schema/contacts.schema.js';

/**
 * Pure Contact → ContactLead mapping. No I/O, no Result.
 * PRECONDITION: contact.fullName is non-null (the routeContact service enforces the
 * MISSING_FULL_NAME quality gate BEFORE calling this). If fullName were null here the
 * produced lead would fail contactLeadSchema — that is by design a programmer error,
 * not a runtime branch, because the gate lives in the service.
 */
export const mapContactToContactLead = (contact: Contact, tenantId: string): ContactLead => ({
  external_id: contact.id,
  phone_e164: contact.phoneE164,
  full_name: contact.fullName as string,
  source: 'whatsapp',
  intent: contact.intent ?? undefined,
  intent_confidence: contact.intentConfidence ?? undefined,
  tags: contact.tags,
  form_payload: undefined,
  captured_at: contact.createdAt.toISOString(),
  tenant_id: tenantId,
});
```

Canonical mapping table (matches proposal Decision 6 + canonical contract):

| ContactLead field | Source | Rule |
|-------------------|--------|------|
| `external_id` | `contact.id` | passthrough |
| `phone_e164` | `contact.phoneE164` | passthrough |
| `full_name` | `contact.fullName` | non-null (gated by service) |
| `source` | literal | always `'whatsapp'` |
| `intent` | `contact.intent` | `null` → `undefined` |
| `intent_confidence` | `contact.intentConfidence` | `null` → `undefined` (already `number` via `mapRowToContact`) |
| `tags` | `contact.tags` | passthrough (`string[]`, never null) |
| `form_payload` | — | always `undefined` |
| `captured_at` | `contact.createdAt` | `.toISOString()` |
| `tenant_id` | `tenantId` arg | = `contact.tenantId` at call site |

Note: tenantId is passed explicitly (not read off `contact.tenantId`) so the mapper does not depend on the row carrying the column; at the call site they are identical (RLS guarantees the row's tenant_id equals the current tenant).

### 4.3 Service `routeContact` (`contacts.routing.ts`)

Signature (exactly as the canonical contract):

```ts
export const routeContact = (
  withTenant: TenantRunner,
  tenantId: string,
  contactId: string,
): Promise<Result<ContactLead, ContactRoutingError>> =>
  withTenant(tenantId, async (tx) => {
    // 1. Atomic read — RLS-scoped, NO WHERE tenant_id. Soft-deleted treated as not-found.
    const rows = await tx
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contactId))
      .limit(1);

    const row = rows[0];
    if (!row || row.deletedAt !== null) {
      return err({ code: 'CONTACT_NOT_FOUND' });
    }

    const contact = mapRowToContact(row);

    // 2. Already routed → no-op: rebuild the lead, do NOT bump routed_at, do NOT insert again.
    if (row.routedAt !== null) {
      return ok(mapContactToContactLead(contact, tenantId));
    }

    // 3. Quality gate: contract requires full_name. Block dirty data at the frontier.
    if (contact.fullName === null) {
      return err({ code: 'MISSING_FULL_NAME' });
    }

    // 4. First-time route — set routed_at AND insert outbox row in THIS SAME tx (atomic).
    const lead = mapContactToContactLead(contact, tenantId);
    try {
      await tx
        .update(contactsTable)
        .set({ routedAt: new Date(), updatedAt: new Date() })
        .where(eq(contactsTable.id, contactId));

      await tx.insert(contactLeadOutboxTable).values({
        tenantId,
        contactId,
        payload: lead, // jsonb; validated by contactLeadSchema at the call boundary if desired
      });

      return ok(lead);
    } catch (e) {
      // Any infra failure rolls back the whole tx (routed_at + outbox) together.
      return err({ code: 'DB_ERROR', cause: e });
    }
  });
```

Key decisions:
- The SELECT does NOT filter `deleted_at` in SQL; it reads then treats `deletedAt !== null` as not-found — identical to `findById`/`update`, so soft-deleted contacts are never routable.
- `routed_at` non-null is checked off the RAW row (`row.routedAt`), not the mapped `Contact`, to avoid forcing `routedAt` into the public mapping if we ever change `mapRowToContact`. (It will be in `Contact` anyway — see §4.4 — but the service reads the raw row regardless.)
- The outbox `payload` is the mapped `ContactLead`. Optional defense-in-depth: `contactLeadSchema.parse(lead)` before insert to fail loudly on contract drift; recommended but the unit test already guarantees the mapper conforms, so we keep the service lean and rely on the mapper unit test. (ADR-4.)
- `tx.update` then `tx.insert` ordering is irrelevant for correctness (same tx) but UPDATE-then-INSERT reads naturally as "mark, then emit".
- Imports: `eq` from `drizzle-orm`; `TenantRunner` from `../db/client.js`; `contactsTable`, `mapRowToContact` from `../db/schema/contacts.schema.js`; `contactLeadOutboxTable` from `../db/schema/contact-lead-outbox.schema.js`; `ContactLead` from `@sivihub/contracts`; `Result`/`ok`/`err` from `../shared/result.js`.

### 4.4 `contacts.schema.ts` — add `routed_at`

Add to `contactsTable`:
```ts
routedAt: timestamp('routed_at', { withTimezone: true, mode: 'date' }), // nullable; NULL = not yet routed
```
Add to `Contact` type: `readonly routedAt: Date | null;`
Add to `mapRowToContact`: `routedAt: row.routedAt ?? null,`

Placement: immediately after `deletedAt` in all three spots, keeping the existing soft-delete/lifecycle columns grouped.

### 4.5 `contact-lead-outbox.schema.ts` — new Drizzle table

```ts
import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ContactLead } from '@sivihub/contracts';

export const contactLeadOutboxTable = pgTable('contact_lead_outbox', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  payload: jsonb('payload').$type<ContactLead>().notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});
```
`$type<ContactLead>()` types the jsonb column so `tx.insert(...).values({ payload: lead })` is typed end-to-end. No FK to `contacts` (outbox must survive even if a contact row is later hard-deleted; consumer-ready record is independent). No mapper needed yet (no read path in this slice); a future worker slice adds `mapRowToOutboxItem`.

---

## 5. Integration points

| Integration point | Direction | Mechanism |
|-------------------|-----------|-----------|
| `tenant.middleware` → handler | in | `c.get('tenantId')` (uuid, already validated) |
| handler → `routeContact` | in | functional call with `deps.db.withTenant` |
| `routeContact` ↔ Postgres | both | single `withTenant` tx; RLS via `set_config` |
| outbox `payload` ↔ `@sivihub/contracts` | out | `ContactLead` shape; `contactLeadSchema` is the write-time contract guard |
| outbox → future CRM consumer | out (future) | rows accumulate `status='pending'`; drained by a future worker slice |

**Forward constraint (worker — documented, NOT built).** The future drain worker MAY poll the outbox via `adminSql` (trusted internal read across tenants for scheduling). But ANY domain write it performs (e.g. `status='sent'`, or writing back to `contacts`) MUST go through `withTenant(tenant_id, …)` using the row's `tenant_id`. Using `adminSql` for a domain WRITE bypasses RLS and is BANNED. This is recorded so the worker slice inherits the constraint. No code in this slice enforces it because the worker does not exist yet.

---

## 6. ADR-style decisions

**ADR-1 — Single success status 200 (route + no-op).**
Decision: both first-time route and idempotent re-route return `200 { routed: ContactLead }`.
Rationale: routing is a state transition returning the emitted lead, not creation of a client-addressable resource; a uniform 200 keeps the contract simple and the no-op indistinguishable from the client's view (idempotent by design).
Rejected: `201 Created` on first route + `200` on no-op — leaks internal state into the status code and complicates idempotency testing for no benefit.

**ADR-2 — Dedicated `ContactRoutingError` + `routingErrorToHttpStatus`.**
Decision: new error union and new local status mapper, not reuse of `ContactError`/`resultToHttpStatus`.
Rationale: routing's codes (`MISSING_FULL_NAME`) don't exist in `ContactError`; sharing would force a wider union and lose `switch` exhaustiveness. Small, exhaustive, type-safe surfaces.
Rejected: extend `ContactError` with `MISSING_FULL_NAME` — pollutes CRUD error space with a routing-only concept.

**ADR-3 — `routeContact` reads the contact itself in ONE tx (NOT `repo.findById`).**
Decision: the service performs the SELECT inside the SAME `withTenant` tx as the writes.
Rationale: `repo.findById` opens and commits its own tx; using it would split read and write across two transactions, allowing a concurrent re-route to slip between the already-routed check and the writes. The canonical contract requires atomic read-then-branch-then-write. One tx = correctness.
Rejected: `findById` + separate write tx (proposal's first phrasing) — non-atomic; corrects the proposal.

**ADR-4 — Outbox `payload` is the mapped `ContactLead`; mapper unit test is the contract guard.**
Decision: store `mapContactToContactLead(...)` result directly as jsonb; rely on the mapper's unit test (validates against `contactLeadSchema`) instead of a runtime `parse` in the hot path.
Rationale: the mapper is pure and fully covered; a per-request `parse` is redundant cost. `$type<ContactLead>()` gives compile-time typing.
Rejected (kept as optional defense): `contactLeadSchema.parse(lead)` before insert — fine to add later if contract drift becomes a real risk; not required now.

**ADR-5 — Ordered-idempotent multi-file runner (no `__migrations` ledger).**
Decision: an explicit ordered array `['0000_contacts.sql', '0001_routing.sql']`, every file self-guarded idempotent, full list re-runnable safely; no applied-migrations tracking table.
Rationale: consistent with the existing 0000 idempotent approach; avoids introducing migration-state infrastructure mid-slice. Each file's `IF NOT EXISTS`/`DROP ... IF EXISTS`/`ADD COLUMN IF NOT EXISTS` guards make re-running the whole list a no-op.
Rejected: a `__migrations` ledger table (drizzle-kit `migrate`) — heavier, changes the bootstrap contract, out of scope for this slice; revisit when migration count grows.

**ADR-6 — Outbox has NO foreign key to `contacts`.**
Decision: `contact_id` is a plain `uuid NOT NULL`, no FK.
Rationale: the outbox is an integration record that must outlive its source contact (consumer-ready even if the contact is later hard-deleted); an FK would couple outbox durability to contacts lifecycle and could block deletes.
Rejected: `REFERENCES contacts(id)` — couples the integration log to the domain table lifecycle.

**ADR-7 — `full_name` gate lives in the SERVICE, mapper stays total.**
Decision: the `MISSING_FULL_NAME` (422) check is in `routeContact`, before calling the pure mapper; the mapper assumes non-null `full_name`.
Rationale: keeps the mapper a total, branch-free pure function (easy to unit-test against `contactLeadSchema`); the quality gate is a service-level policy, not a mapping concern.
Rejected: mapper returns `Result<ContactLead, ContactRoutingError>` — pushes I/O-free policy into the mapper and complicates its unit test matrix.

---

## 7. Testing strategy (Strict TDD)

Red→Green→Refactor. Write the failing test first for each unit below.

### 7.1 Unit — `mapContactToContactLead` (Docker-free)
File: `apps/backend/test/contacts/contacts.routing.map.test.ts`.
- Given a fully-populated `Contact` (intent, intentConfidence, tags) → assert every field per the mapping table; `source === 'whatsapp'`; `captured_at === createdAt.toISOString()`; `form_payload === undefined`.
- Given a `Contact` with `intent: null`, `intentConfidence: null` → `intent`/`intent_confidence` are `undefined`.
- Given empty `tags` → `tags: []`.
- VALIDATE the output with `contactLeadSchema.safeParse(lead).success === true` for the non-null-full_name case. (This is the contract guard ADR-4 relies on.)

### 7.2 Integration — `routeContact` + endpoint (Testcontainers as app_rls, ONE shared container)
File: `apps/backend/test/contacts/contacts.routing.int.test.ts`. Use `createTestDb()` (now runs both migration files). `beforeAll` start container, `afterAll` teardown, `afterEach` truncate (both tables). Seven scenarios per the canonical contract:

1. **Happy path** — seed live named contact; `routeContact` → `ok(lead)`; assert `lead` validates `contactLeadSchema`; assert `contacts.routed_at` is now set; assert EXACTLY ONE outbox row exists for the tenant with `payload` deep-equal to `lead` and `status='pending'`.
2. **Not found** — random uuid → `err(CONTACT_NOT_FOUND)`; no outbox row.
3. **Soft-deleted = not found** — seed then soft-delete; route → `err(CONTACT_NOT_FOUND)`; no outbox row.
4. **Missing full_name → 422** — seed contact with `fullName: null`; route → `err(MISSING_FULL_NAME)`; assert NO outbox row AND `routed_at` still NULL.
5. **No-op idempotency** — route once (1 outbox row), route again → second call `ok(lead)`; assert STILL exactly ONE outbox row; assert `routed_at` unchanged (capture timestamp after first route, compare).
6. **Tenant isolation** — seed contacts for tenant A and tenant B; route A's contact under tenant A; assert tenant B (via `withTenant(B, …)` SELECT on `contact_lead_outbox`) sees ZERO rows (RLS blocks cross-tenant read); routing B's id under tenant A → `CONTACT_NOT_FOUND` (RLS hides A from B's row and vice-versa).
7. **Atomicity / GRANT** — the happy-path INSERT must succeed AS app_rls (proves `GRANT INSERT ON contact_lead_outbox TO app_rls`); additionally assert that the outbox row and the `routed_at` update are both visible (committed together) — read both in a fresh `withTenant` after the route returns. (Negative atomicity — forcing the INSERT to fail and asserting `routed_at` rolled back — is a SUGGESTION-level test; hard to induce without a constraint violation, can be added by violating a NOT NULL via a crafted payload if desired.)

HTTP-layer endpoint tests (optional but recommended, same file or a `.route.test.ts`): drive `POST /contacts/:id/route` through the Hono app with `X-Tenant-Id` and assert 200/404/422 + body shape `{ routed }`. Reuse the existing app test harness pattern from the contacts CRUD tests.

### 7.3 Test infra reuse
- ONE container shared across the integration suite (`createTestDb` in `beforeAll`).
- `createTestDb` now applies `[0000, 0001]` so the outbox table + grant + routed_at exist.
- `truncate()` clears `contact_lead_outbox` + `contacts`.
- Reads under app_rls go through `withTenant`; setup/cross-tenant assertions go through `adminQuery`.

---

## 8. Invariants held

- `Result<T,E>` in all domain logic; throws only at infra (caught and wrapped into `DB_ERROR`).
- NO `WHERE tenant_id` anywhere — RLS via `set_config('app.current_tenant', …)`.
- Functional DI: `routeContact(withTenant, tenantId, contactId)` — no container, no class.
- ONE `withTenant` tx for the routing read + both writes — atomic.
- Postgres-only; outbox is a Postgres table with RLS ENABLE+FORCE + `tenant_isolation`.
- `adminSql` never used for domain writes (only migration/test bootstrap); worker forward-constraint documented.
- Multi-file runner stays idempotent: each file self-guarded; full ordered list re-runnable as a no-op; `makeIdempotent` matches only 0000's role line and is a no-op for 0001.
