# Spec — contactlead-routing

> Change: 2026-06-23-contactlead-routing
> Domain: contacts (new routing capability + outbox table)
> Artifact store: hybrid

---

## Purpose

Define the observable behavior for routing a WhatsApp contact to the SiviHub CRM via the `ContactLead` contract. Routing marks the contact with a timestamp, emits a validated payload into a tenant-scoped transactional outbox, and enforces data-quality and idempotency invariants. This spec describes WHAT must be true — not how it is implemented.

---

## Schema Extensions

### Requirement: contacts.routed_at Column

The `contacts` table MUST gain a nullable `routed_at TIMESTAMPTZ` column.

| Column | Type | Constraint |
|--------|------|------------|
| `routed_at` | `TIMESTAMPTZ` | NULLABLE; `NULL` means not yet routed |

`NULL` is the canonical "not yet routed" sentinel. A non-null value means the contact has been successfully routed at least once. This column MUST NOT have a non-null default.

---

### Requirement: contact_lead_outbox Table

The system MUST create a `contact_lead_outbox` table with the following shape.

| Column | Type | Constraint |
|--------|------|------------|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()`, NOT NULL |
| `tenant_id` | `UUID` | NOT NULL |
| `contact_id` | `UUID` | NOT NULL |
| `payload` | `JSONB` | NOT NULL |
| `status` | `TEXT` | NOT NULL, DEFAULT `'pending'` |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |

RLS rules for `contact_lead_outbox`:
- Row-level security MUST be `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- A `tenant_isolation` policy MUST restrict SELECT and INSERT to rows where `tenant_id = current_setting('app.current_tenant')::uuid` (`USING` and `WITH CHECK`).
- The migration MUST `GRANT SELECT, INSERT ON contact_lead_outbox TO app_rls`.
- NO application query MAY include an explicit `WHERE tenant_id` clause; isolation is enforced exclusively by RLS.

#### Scenario: outbox table exists with correct shape

- GIVEN the `0001_routing.sql` migration has been applied
- WHEN the schema is introspected
- THEN `contact_lead_outbox` exists with all columns above
- AND RLS is enabled and forced on the table
- AND `app_rls` has SELECT and INSERT grants

---

## New Capability: contactlead-routing

### Requirement: ContactRoutingError Type

The system MUST define `ContactRoutingError` as a discriminated union with the following codes. No other codes are permitted in this slice.

| Code | Meaning |
|------|---------|
| `CONTACT_NOT_FOUND` | No active contact with that id under the current tenant |
| `MISSING_FULL_NAME` | The contact's `full_name` is `null`; routing is blocked |
| `DB_ERROR` | Unexpected infrastructure failure |

`ContactRoutingError` values MUST be returned via `err(...)` — domain logic MUST NOT throw.

---

### Requirement: ContactLead Mapping

`mapContactToLead(contact): Result<ContactLead, ContactRoutingError>` MUST produce a `ContactLead` with the following field mapping. The function MUST be pure (no I/O).

| ContactLead field | Source |
|-------------------|--------|
| `external_id` | `contact.id` |
| `phone_e164` | `contact.phoneE164` |
| `full_name` | `contact.full_name` (guaranteed non-null past the gate) |
| `source` | Always the literal `'whatsapp'` |
| `intent` | `contact.intent ?? undefined` (null → undefined) |
| `intent_confidence` | `contact.intentConfidence ?? undefined` (null → undefined) |
| `tags` | `contact.tags` (passthrough) |
| `form_payload` | Always `undefined` |
| `captured_at` | `contact.createdAt.toISOString()` |
| `tenant_id` | `contact.tenantId` |

`full_name` null check MUST happen before mapping. If `contact.full_name` is null, the function MUST return `err({ code: 'MISSING_FULL_NAME' })` without producing a partial `ContactLead`.

#### Scenario: valid contact maps to ContactLead

- GIVEN a contact with all fields populated (`full_name` non-null, `intent = 'buy'`, `intent_confidence = 0.9`, `tags = ['vip']`, created at `T`)
- WHEN `mapContactToLead(contact)` is called
- THEN `result.ok` is `true`
- AND `result.value.external_id` equals `contact.id`
- AND `result.value.source` is the string `'whatsapp'`
- AND `result.value.captured_at` equals `contact.createdAt.toISOString()`
- AND `result.value.form_payload` is `undefined`

#### Scenario: null intent maps to undefined

- GIVEN a contact with `intent = null` and `intent_confidence = null`
- WHEN `mapContactToLead(contact)` is called
- THEN `result.ok` is `true`
- AND `result.value.intent` is `undefined`
- AND `result.value.intent_confidence` is `undefined`

#### Scenario: null full_name blocks mapping

- GIVEN a contact with `full_name = null`
- WHEN `mapContactToLead(contact)` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `'MISSING_FULL_NAME'`

---

### Requirement: routeContact Service

`routeContact(withTenant: TenantRunner, tenantId: string, contactId: string): Promise<Result<ContactLead, ContactRoutingError>>` MUST execute ALL reads and writes atomically inside a SINGLE `withTenant` transaction. No partial commits are permitted.

> **ADR-3 reconciliation**: The original spec referenced `routeContact(id, repo, db)` with `repo.findById`. This was corrected in the design: the service performs the SELECT itself inside the same `withTenant` tx as the writes (not via `repo.findById` which opens its own tx). One tx = atomic read + branch + write. See design §4.3 and §6 ADR-3.

Within that transaction, the service MUST follow this decision sequence:

1. Fetch the contact by `id` (active, non-deleted) via the repository. If not found → `err(CONTACT_NOT_FOUND)`.
2. If `contact.full_name` is null → `err(MISSING_FULL_NAME)`. No DB write occurs.
3. If `contact.routed_at` is non-null → return `ok(mapped ContactLead)` immediately. Do NOT update `routed_at`. Do NOT insert an outbox row.
4. Otherwise: set `contacts.routed_at = now()` AND insert one `contact_lead_outbox` row with `payload` = the mapped `ContactLead` (validated against `contactLeadSchema` at write time) and `status = 'pending'`. Return `ok(mapped ContactLead)`.

Any unexpected DB failure MUST return `err({ code: 'DB_ERROR' })` — never throw.

#### Scenario: route valid named contact — happy path

- GIVEN a contact exists with `full_name = 'Ana García'`, `routed_at = null`, active (not deleted)
- WHEN `routeContact(withTenant, contact.tenantId, contact.id)` is called
- THEN `result.ok` is `true`
- AND `result.value` is a valid `ContactLead` with `source = 'whatsapp'`, `external_id = contact.id`, `captured_at = contact.createdAt.toISOString()`
- AND `contacts.routed_at` is set to a non-null timestamp in the DB
- AND exactly ONE row exists in `contact_lead_outbox` for this `contact_id`
- AND the outbox row's `payload` validates against `contactLeadSchema`

#### Scenario: contact has null full_name — rejected

- GIVEN a contact with `full_name = null`, `routed_at = null`
- WHEN `routeContact(withTenant, contact.tenantId, contact.id)` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `'MISSING_FULL_NAME'`
- AND `contacts.routed_at` remains `null`
- AND no row is inserted in `contact_lead_outbox`

#### Scenario: contact already routed — no-op

- GIVEN a contact with `full_name = 'Ana'`, `routed_at` non-null, and exactly ONE existing outbox row
- WHEN `routeContact(withTenant, contact.tenantId, contact.id)` is called again
- THEN `result.ok` is `true`
- AND `contacts.routed_at` is unchanged (same timestamp as before)
- AND `contact_lead_outbox` still contains exactly ONE row for this `contact_id` (no duplicate inserted)

#### Scenario: atomicity — routed_at and outbox are written together or not at all

- GIVEN a contact eligible for routing
- WHEN a simulated failure occurs after `routed_at` is set but before the outbox INSERT commits (e.g., transaction rollback)
- THEN `contacts.routed_at` remains `null`
- AND no outbox row exists for this contact
- AND `result.ok` is `false`

---

### Requirement: POST /contacts/:id/route Endpoint

`POST /contacts/:id/route` MUST be registered on the contacts router. The endpoint MUST:

- Require `X-Tenant-Id` (enforced by existing tenant middleware; missing/invalid header → 401/400 as per existing behavior).
- Obtain `tenantId` from `c.get('tenantId')` — MUST NOT read the header directly in the handler.
- Invoke `routeContact` with the path parameter `id`.
- Map `Result<ContactLead, ContactRoutingError>` to HTTP responses per the table below.

| `ContactRoutingError` code | HTTP status | Response body |
|----------------------------|-------------|---------------|
| `CONTACT_NOT_FOUND` | `404` | `{ "error": "CONTACT_NOT_FOUND" }` |
| `MISSING_FULL_NAME` | `422` | `{ "error": "MISSING_FULL_NAME" }` |
| `DB_ERROR` | `500` | `{ "error": "INTERNAL_ERROR" }` |

Success (including idempotent no-op): HTTP `200` with body `{ "routed": <ContactLead> }`.

The route MUST be declared before `/:id` in the router file so it is not shadowed by the dynamic segment.

#### Scenario: route valid contact → 200 with ContactLead body

- GIVEN a tenant with a valid named contact (not yet routed)
- AND a valid `X-Tenant-Id` header is set
- WHEN `POST /contacts/:id/route` is called
- THEN the response status is `200`
- AND the body is `{ "routed": <ContactLead> }` where `routed.source` is `'whatsapp'`, `routed.external_id` equals the contact id, and `routed.captured_at` is an ISO 8601 string
- AND `contacts.routed_at` is set in the DB
- AND one outbox row exists with status `'pending'`

#### Scenario: route contact with null full_name → 422

- GIVEN a tenant with a contact whose `full_name` is null
- WHEN `POST /contacts/:id/route` is called
- THEN the response status is `422`
- AND the body is `{ "error": "MISSING_FULL_NAME" }`
- AND `contacts.routed_at` remains `null`
- AND no outbox row is inserted

#### Scenario: route non-existent or soft-deleted contact → 404

- GIVEN no active contact exists for the given id under the current tenant
- WHEN `POST /contacts/:id/route` is called
- THEN the response status is `404`
- AND the body is `{ "error": "CONTACT_NOT_FOUND" }`

#### Scenario: route already-routed contact → 200 no-op

- GIVEN a contact that was previously routed (`routed_at` non-null, one outbox row exists)
- WHEN `POST /contacts/:id/route` is called again
- THEN the response status is `200`
- AND the body is `{ "routed": <ContactLead> }`
- AND `contact_lead_outbox` still has exactly ONE row for this contact (no duplicate)
- AND `contacts.routed_at` is unchanged

---

### Requirement: Outbox Tenant Isolation

Outbox rows written under tenant A MUST NOT be visible to tenant B. RLS on `contact_lead_outbox` enforces this with no `WHERE tenant_id` in application queries.

#### Scenario: tenant A outbox row invisible to tenant B

- GIVEN tenant A routes a contact successfully (one outbox row written)
- WHEN the DB is queried as `app_rls` with `SET LOCAL app.current_tenant = '<tenant_B_id>'`
- AND `SELECT * FROM contact_lead_outbox` is executed
- THEN zero rows are returned for tenant B
- AND the row is visible when queried under tenant A's context

---

### Requirement: Outbox Payload Schema Conformance

Every `payload` value inserted into `contact_lead_outbox` MUST be a valid `ContactLead` as defined by `contactLeadSchema` (Zod). Validation MUST occur at write time, before the INSERT. An invalid payload MUST result in `err({ code: 'DB_ERROR' })` — no invalid payload MUST ever be persisted.

#### Scenario: persisted outbox payload validates against contactLeadSchema

- GIVEN a contact has been successfully routed
- WHEN the outbox row's `payload` is retrieved and parsed with `contactLeadSchema.safeParse`
- THEN `parseResult.success` is `true`
- AND `parseResult.data.source` is `'whatsapp'`
- AND `parseResult.data.external_id` equals the contact's `id`
- AND `parseResult.data.captured_at` is a valid ISO 8601 string

---

## Out of Scope

- Worker/drain process — the outbox accumulates rows; no consumer exists in this slice.
- Re-routing (explicit re-emit) — a future `re-route` action if ever needed.
- Outbox TTL, monitoring, or cleanup.
- CRM HTTP call or any cross-service I/O.
- Auto-routing triggered by intent changes.
- `WHERE tenant_id` in any query (RLS only, always).
