# Specification — contacts

> Domain: contacts · Project: sivi-whatsapp-hub
> This is the main contacts domain specification, built from contact-phone-e164-dedupe (2026-06-22).

## Purpose

Establish the canonical domain types and behaviors for the WhatsApp Hub's contact management system. This slice introduces the Result<T,E> primitive (used project-wide) and E.164 phone normalization + deduplication detection for Peru mobiles.

---

## Requirements

### Requirement: Result Type and Helpers

The system MUST expose a `Result<T, E>` discriminated union at `apps/backend/src/shared/result.ts` with the following shape and helpers. This shape is the project-wide canonical form; no alternative Result type is permitted.

- `Ok<T>` = `{ readonly ok: true; readonly value: T }`
- `Err<E>` = `{ readonly ok: false; readonly error: E }`
- `Result<T, E>` = `Ok<T> | Err<E>`
- `ok<T>(value: T): Ok<T>` — constructs a success variant
- `err<E>(error: E): Err<E>` — constructs a failure variant
- `isOk<T, E>(r: Result<T, E>): r is Ok<T>` — narrows to `Ok<T>`
- `isErr<T, E>(r: Result<T, E>): r is Err<E>` — narrows to `Err<E>`

All fields MUST be `readonly`. Helpers MUST be exported named exports.

#### Scenario: ok helper produces a success variant

- GIVEN a value `42`
- WHEN `ok(42)` is called
- THEN the result is `{ ok: true, value: 42 }`
- AND `result.ok` is `true`
- AND `result.value` is `42`

#### Scenario: err helper produces a failure variant

- GIVEN an error object `{ code: 'INVALID_FORMAT', input: 'bad' }`
- WHEN `err({ code: 'INVALID_FORMAT', input: 'bad' })` is called
- THEN the result is `{ ok: false, error: { code: 'INVALID_FORMAT', input: 'bad' } }`
- AND `result.ok` is `false`

#### Scenario: isOk narrows correctly on a success result

- GIVEN `const r = ok('hello')`
- WHEN `isOk(r)` is called
- THEN it returns `true`

#### Scenario: isOk returns false on a failure result

- GIVEN `const r = err({ code: 'EMPTY_INPUT', input: '' })`
- WHEN `isOk(r)` is called
- THEN it returns `false`

#### Scenario: isErr narrows correctly on a failure result

- GIVEN `const r = err({ code: 'EMPTY_INPUT', input: '' })`
- WHEN `isErr(r)` is called
- THEN it returns `true`

#### Scenario: isErr returns false on a success result

- GIVEN `const r = ok('+51987654321')`
- WHEN `isErr(r)` is called
- THEN it returns `false`

---

### Requirement: PhoneNormalizationError Type

The system MUST define `PhoneNormalizationError` as:

```
{ readonly code: 'EMPTY_INPUT' | 'INVALID_FORMAT'; readonly input: string }
```

`input` MUST carry the original raw string passed by the caller (not a trimmed or stripped version). No other error codes are permitted in this slice.

---

### Requirement: normalizePhoneE164 — Valid Inputs

`normalizePhoneE164(input: string): Result<string, PhoneNormalizationError>` MUST return `Ok<string>` carrying the canonical `+51XXXXXXXXX` form for all of the following input shapes. The X digits are the 9-digit mobile number starting with `9`.

#### Scenario: already E.164

- GIVEN input `"+51987654321"`
- WHEN `normalizePhoneE164("+51987654321")` is called
- THEN the result is `ok('+51987654321')`
- AND `result.ok` is `true` and `result.value` is `"+51987654321"`

#### Scenario: country prefix without plus sign

- GIVEN input `"51987654321"`
- WHEN `normalizePhoneE164("51987654321")` is called
- THEN the result is `ok('+51987654321')`

#### Scenario: bare 9-digit local mobile

- GIVEN input `"987654321"`
- WHEN `normalizePhoneE164("987654321")` is called
- THEN the result is `ok('+51987654321')`

#### Scenario: E.164 with spaces

- GIVEN input `"+51 987 654 321"`
- WHEN `normalizePhoneE164("+51 987 654 321")` is called
- THEN the result is `ok('+51987654321')`

#### Scenario: formatted with parentheses and hyphens

- GIVEN input `"(+51) 987-654-321"`
- WHEN `normalizePhoneE164("(+51) 987-654-321")` is called
- THEN the result is `ok('+51987654321')`

---

### Requirement: normalizePhoneE164 — Invalid Inputs

`normalizePhoneE164` MUST return `Err<PhoneNormalizationError>` for any input that is not a valid Peru mobile. The `error.input` MUST equal the original raw string passed in.

#### Scenario: empty string → EMPTY_INPUT

- GIVEN input `""`
- WHEN `normalizePhoneE164("")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"EMPTY_INPUT"`
- AND `result.error.input` is `""`

#### Scenario: whitespace-only string → EMPTY_INPUT

- GIVEN input `"   "`
- WHEN `normalizePhoneE164("   ")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"EMPTY_INPUT"`
- AND `result.error.input` is `"   "`

#### Scenario: too-short digit string → INVALID_FORMAT

- GIVEN input `"12345"`
- WHEN `normalizePhoneE164("12345")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`
- AND `result.error.input` is `"12345"`

#### Scenario: 8-digit local number (not a mobile, first digit not 9) → INVALID_FORMAT

- GIVEN input `"12345678"`
- WHEN `normalizePhoneE164("12345678")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`

#### Scenario: Lima landline format → INVALID_FORMAT

- GIVEN input `"014561234"` (9 digits but first digit is not 9)
- WHEN `normalizePhoneE164("014561234")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`
- AND `result.error.input` is `"014561234"`

#### Scenario: alphabetic / garbage input → INVALID_FORMAT

- GIVEN input `"abcdef"`
- WHEN `normalizePhoneE164("abcdef")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`
- AND `result.error.input` is `"abcdef"`

#### Scenario: 10 local digits (one digit too many) → INVALID_FORMAT

- GIVEN input `"9876543210"` (10 digits, no country prefix)
- WHEN `normalizePhoneE164("9876543210")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_FORMAT"`
- AND `result.error.input` is `"9876543210"`

---

### Requirement: normalizePhoneBatch

`normalizePhoneBatch(inputs: ReadonlyArray<string>): NormalizationReport` MUST:
- Process every element in `inputs` (MUST NOT silently drop any element).
- Partition results into `valid` (normalized) and `invalid` (with error).
- Preserve the original `input` string in both buckets.
- Preserve order within each bucket (same relative order as in `inputs`).
- Return `{ valid: ReadonlyArray<NormalizedEntry>; invalid: ReadonlyArray<InvalidEntry> }`.

#### Scenario: mixed batch of valid and invalid inputs

- GIVEN inputs `["+51987654321", "abcdef", "987654321", ""]`
- WHEN `normalizePhoneBatch(["+51987654321", "abcdef", "987654321", ""])` is called
- THEN `report.valid` has 2 entries:
  - `{ input: "+51987654321", phoneE164: "+51987654321" }`
  - `{ input: "987654321", phoneE164: "+51987654321" }`
- AND `report.invalid` has 2 entries:
  - `{ input: "abcdef", error: { code: "INVALID_FORMAT", input: "abcdef" } }`
  - `{ input: "", error: { code: "EMPTY_INPUT", input: "" } }`

#### Scenario: empty array

- GIVEN inputs `[]`
- WHEN `normalizePhoneBatch([])` is called
- THEN `report.valid` is `[]`
- AND `report.invalid` is `[]`

#### Scenario: all valid batch

- GIVEN inputs `["+51987654321", "51987654321", "987654321"]`
- WHEN `normalizePhoneBatch(...)` is called
- THEN `report.valid` has 3 entries, all with `phoneE164: "+51987654321"`
- AND `report.invalid` is `[]`

#### Scenario: all invalid batch

- GIVEN inputs `["", "abc", "12345"]`
- WHEN `normalizePhoneBatch(...)` is called
- THEN `report.valid` is `[]`
- AND `report.invalid` has 3 entries with codes `["EMPTY_INPUT", "INVALID_FORMAT", "INVALID_FORMAT"]`

---

### Requirement: detectPhoneDuplicates

`detectPhoneDuplicates(phones: ReadonlyArray<string>): DedupeReport` MUST:
- Operate on **already-normalized** E.164 strings (callers are responsible for normalization).
- Group by exact string match.
- Report only groups with 2 or more members in `duplicates`.
- Report each group's `phoneE164` key and `indexes` (0-based positions in the input array).
- Report `uniqueCount` as the count of distinct `phoneE164` values in the input.
- MUST NOT merge, mutate, or remove any element.

#### Scenario: no duplicates

- GIVEN phones `["+51987654321", "+51912345678", "+51998765432"]`
- WHEN `detectPhoneDuplicates(...)` is called
- THEN `report.duplicates` is `[]`
- AND `report.uniqueCount` is `3`

#### Scenario: one duplicate pair

- GIVEN phones `["+51987654321", "+51912345678", "+51987654321"]`
- WHEN `detectPhoneDuplicates(...)` is called
- THEN `report.duplicates` has exactly 1 group:
  - `{ phoneE164: "+51987654321", indexes: [0, 2] }`
- AND `report.uniqueCount` is `2`

#### Scenario: triplicate plus a unique

- GIVEN phones `["+51987654321", "+51912345678", "+51987654321", "+51987654321"]`
- WHEN `detectPhoneDuplicates(...)` is called
- THEN `report.duplicates` has exactly 1 group:
  - `{ phoneE164: "+51987654321", indexes: [0, 2, 3] }`
- AND `report.uniqueCount` is `2`

#### Scenario: multiple duplicate groups

- GIVEN phones `["+51987654321", "+51912345678", "+51987654321", "+51912345678"]`
- WHEN `detectPhoneDuplicates(...)` is called
- THEN `report.duplicates` has 2 groups:
  - `{ phoneE164: "+51987654321", indexes: [0, 2] }`
  - `{ phoneE164: "+51912345678", indexes: [1, 3] }`
- AND `report.uniqueCount` is `2`

#### Scenario: empty array

- GIVEN phones `[]`
- WHEN `detectPhoneDuplicates([])` is called
- THEN `report.duplicates` is `[]`
- AND `report.uniqueCount` is `0`

#### Scenario: single element (cannot be a duplicate)

- GIVEN phones `["+51987654321"]`
- WHEN `detectPhoneDuplicates(["+51987654321"])` is called
- THEN `report.duplicates` is `[]`
- AND `report.uniqueCount` is `1`

---

## Out of Scope (Non-Requirements for This Slice: contact-phone-e164-dedupe)

- Dedupe merge / winner selection — detection only.
- Landlines — Peru mobiles only (`+51` + 9 digits, first digit `9`).
- `WRONG_COUNTRY` error code — non-Peru inputs are `INVALID_FORMAT`.
- Persistence, RLS, HTTP — pure domain.
- `contactLeadSchema.phone_e164` regex tightening — separate follow-up.
- Any alternative `Result<T, E>` shape — the shape above is final and project-wide.

---

## New Capability: tenant-isolation

### Requirement: Contacts Table Shape

The `contacts` table MUST be created with the following columns and constraints.

| Column | Type | Constraint |
|--------|------|-----------|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()`, NOT NULL |
| `tenant_id` | `UUID` | NOT NULL |
| `phone_e164` | `TEXT` | NOT NULL |
| `full_name` | `TEXT` | NULLABLE |
| `source` | `TEXT` | NULLABLE |
| `tags` | `TEXT[]` | NOT NULL, DEFAULT `'{}'` |
| `intent` | `TEXT` | NULLABLE |
| `intent_confidence` | `NUMERIC(5,4)` | NULLABLE; `CHECK (intent_confidence >= 0 AND intent_confidence <= 1)` |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |
| `deleted_at` | `TIMESTAMPTZ` | NULLABLE (soft-delete sentinel) |

The table MUST have a unique constraint on `(tenant_id, phone_e164)`.
Row-level security MUST be ENABLED on the table.
The `intent_confidence` column MUST carry a `CHECK (intent_confidence >= 0 AND intent_confidence <= 1)` constraint so out-of-range values are rejected at the database level.

> **NOTE — driver numeric coercion:** Some Postgres drivers return `NUMERIC` columns as strings. The domain type `Contact.intentConfidence` MUST be declared as `number | null` and the repository mapping MUST coerce the raw driver value to a JS `number` (e.g. via `parseFloat`) before returning the domain object.

#### Scenario: table exists with correct shape

- GIVEN a fresh Drizzle migration has been applied
- WHEN the schema is introspected
- THEN `contacts` exists with all columns above
- AND a unique index on `(tenant_id, phone_e164)` is present
- AND RLS is enabled on the table

#### Scenario: out-of-range intent_confidence is rejected

- GIVEN a valid tenant context is set
- WHEN an INSERT or UPDATE sets `intent_confidence = 1.5`
- THEN the database rejects the write with a CHECK constraint violation
- AND no row is persisted or modified

#### Scenario: intent_confidence returned as JS number

- GIVEN a contact was stored with `intent_confidence = 0.9500`
- WHEN the repository returns the domain `Contact` object
- THEN `contact.intentConfidence` is the JS `number` `0.95` (not the string `"0.9500"`)
- AND `typeof contact.intentConfidence === 'number'` is `true`

---

### Requirement: RLS Tenant Isolation Policy

The `contacts` table MUST have a row-level security policy named `tenant_isolation` that restricts SELECT, INSERT, UPDATE, and DELETE to rows where `tenant_id = current_setting('app.current_tenant')::uuid`.

- The policy MUST be created via the SQL migration (not application code).
- NO application query on `contacts` MAY include an explicit `WHERE tenant_id = ?` clause; isolation is enforced exclusively by RLS.
- The session variable MUST be set via `SET LOCAL app.current_tenant = '<uuid>'` inside a transaction before any query executes.

> **NOTE — app-role enforcement:** Postgres RLS is bypassed by superusers and (without `FORCE ROW LEVEL SECURITY`) by the table owner. Therefore: (1) the application MUST connect as a dedicated non-superuser, non-BYPASSRLS role named `app_rls`; (2) the migration MUST provision `app_rls` with the minimal grant `GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_rls`; (3) integration tests that assert RLS behaviour MUST connect AS `app_rls`, not as the migration superuser.

#### Scenario: tenant A cannot see tenant B rows (SELECT isolation)

- GIVEN tenant A (id `aaa...`) and tenant B (id `bbb...`) each have one contact in the DB
- WHEN `SET LOCAL app.current_tenant = 'aaa...'` is run in a transaction
- AND `SELECT * FROM contacts` is executed
- THEN only the row with `tenant_id = 'aaa...'` is returned
- AND the row with `tenant_id = 'bbb...'` is NOT returned

#### Scenario: tenant A cannot update tenant B rows

- GIVEN a row belonging to tenant B
- WHEN `SET LOCAL app.current_tenant = 'aaa...'` is run
- AND an `UPDATE contacts SET full_name = 'X' WHERE id = <tenant_B_id>` is executed
- THEN 0 rows are affected (RLS hides the row; no error is raised)

#### Scenario: tenant A cannot delete tenant B rows

- GIVEN a row belonging to tenant B
- WHEN `SET LOCAL app.current_tenant = 'aaa...'` is run
- AND a `DELETE FROM contacts WHERE id = <tenant_B_id>` is executed
- THEN 0 rows are affected

#### Scenario: no SET LOCAL → query returns empty

- GIVEN rows exist in the `contacts` table
- WHEN a query is run in a transaction WITHOUT calling `SET LOCAL app.current_tenant`
- THEN 0 rows are returned (RLS default-deny when setting is absent or empty string)

#### Scenario: RLS holds under non-superuser app role (app-role enforcement)

- GIVEN the app connects as the non-superuser role `app_rls` (not the Postgres superuser or table owner)
- AND tenant A and tenant B each have one contact row
- WHEN `SET LOCAL app.current_tenant = 'aaa...'` is run inside a transaction
- AND `SELECT * FROM contacts` is executed
- THEN only the tenant A row is returned
- AND the tenant B row is NOT returned

#### Scenario: WITH CHECK blocks foreign-tenant INSERT

- GIVEN `SET LOCAL app.current_tenant = 'aaa...'` is set in the current transaction
- WHEN an INSERT into `contacts` specifies a row with `tenant_id = 'bbb...'` (tenant B)
- THEN the INSERT is rejected by the `WITH CHECK` clause of the `tenant_isolation` policy
- AND no row is persisted

---

### Requirement: Tenant Middleware

The backend MUST provide a tenant middleware that sets the session tenant before any domain route handler executes.

- In `AUTH_MODE=dev-header`, the middleware MUST read the `X-Tenant-Id` header, validate it as a UUID via Zod, and run `SET LOCAL app.current_tenant = '<uuid>'` inside the request transaction.
- A missing `X-Tenant-Id` header MUST result in a `401 Unauthorized` response; the route handler MUST NOT be invoked.
- An `X-Tenant-Id` header with a non-UUID value MUST result in a `400 Bad Request` response.
- The `AUTH_MODE=dev-header` behavior MUST be gated by the `AUTH_MODE` environment variable; it MUST NOT be active in production (`AUTH_MODE !== 'dev-header'`).
- The middleware MUST be attached to all `/contacts` routes and any future domain routes; it MUST NOT be attached to the `/health` route.

#### Scenario: valid UUID header → request proceeds

- GIVEN `AUTH_MODE=dev-header` and `X-Tenant-Id: 550e8400-e29b-41d4-a716-446655440000`
- WHEN a request is made to `GET /contacts`
- THEN the middleware sets `app.current_tenant` to that UUID
- AND the route handler is invoked
- AND the response status is `200`

#### Scenario: missing header → 401

- GIVEN `AUTH_MODE=dev-header` and no `X-Tenant-Id` header
- WHEN a request is made to `GET /contacts`
- THEN the response status is `401`
- AND the response body contains `{ "error": "MISSING_TENANT" }`
- AND the route handler is NOT invoked

#### Scenario: non-UUID header value → 400

- GIVEN `AUTH_MODE=dev-header` and `X-Tenant-Id: not-a-uuid`
- WHEN a request is made to `GET /contacts`
- THEN the response status is `400`
- AND the response body contains `{ "error": "INVALID_TENANT_ID" }`

---

## New Capability: contacts-persistence

### Requirement: Contacts Repository Interface

`createContactsRepository(db)` MUST return a repository with the following operations. Every operation MUST return `Result<T, ContactsRepositoryError>`; domain code MUST NOT throw.

| Operation | Signature summary | Description |
|-----------|------------------|-------------|
| `create` | `(input: CreateContactInput) => Promise<Result<Contact, ContactsRepositoryError>>` | Normalize phone, check for conflict or soft-deleted row, persist |
| `findById` | `(id: string) => Promise<Result<Contact, ContactsRepositoryError>>` | Fetch active (non-deleted) row by UUID |
| `list` | `(opts?: ListContactsOptions) => Promise<Result<Contact[], ContactsRepositoryError>>` | List active contacts, no soft-deleted rows |
| `update` | `(id: string, patch: UpdateContactInput) => Promise<Result<Contact, ContactsRepositoryError>>` | Update mutable fields; touch `updated_at` |
| `softDelete` | `(id: string) => Promise<Result<void, ContactsRepositoryError>>` | Set `deleted_at = now()`; idempotent |

`ContactsRepositoryError` codes:

| Code | Meaning |
|------|---------|
| `CONTACT_NOT_FOUND` | No active row with that id under the current tenant |
| `CONTACT_ALREADY_EXISTS` | A live contact with the same normalized `phone_e164` already exists for this tenant |
| `INVALID_PHONE` | The provided phone fails `normalizePhoneE164` |
| `DB_ERROR` | Unexpected infrastructure failure |

---

### Requirement: Create Contact — Happy Path

`create` MUST normalize the input phone via `normalizePhoneE164`, store the E.164 value in `phone_e164`, and return `ok(contact)` on success.

#### Scenario: create new contact succeeds

- GIVEN the current tenant has no contact with phone `"987654321"`
- WHEN `create({ phone: "987654321", full_name: "Ana García" })` is called
- THEN `result.ok` is `true`
- AND `result.value.phone_e164` is `"+51987654321"`
- AND `result.value.full_name` is `"Ana García"`
- AND `result.value.deleted_at` is `null`
- AND `result.value.id` is a UUID

---

### Requirement: Create Contact — Conflict Semantics

If a live (non-deleted) contact with the same normalized `phone_e164` already exists for the current tenant, `create` MUST return `err({ code: 'CONTACT_ALREADY_EXISTS' })`. If a soft-deleted contact with the same phone exists, `create` MUST resurrect it: clear `deleted_at`, apply the new field values, update `updated_at`, and return `ok(resurrectedContact)`.

#### Scenario: phone already exists (live) → 409 domain error

- GIVEN a live contact with `phone_e164 = "+51987654321"` exists for the current tenant
- WHEN `create({ phone: "+51987654321", full_name: "Otro" })` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"CONTACT_ALREADY_EXISTS"`

#### Scenario: phone belongs to soft-deleted contact → resurrect

- GIVEN a contact with `phone_e164 = "+51987654321"` was soft-deleted (`deleted_at` is set)
- WHEN `create({ phone: "+51987654321", full_name: "Ana Reborn" })` is called
- THEN `result.ok` is `true`
- AND `result.value.deleted_at` is `null`
- AND `result.value.full_name` is `"Ana Reborn"`
- AND no new row is inserted (same `id` as the original)

#### Scenario: invalid phone → domain error

- GIVEN any tenant state
- WHEN `create({ phone: "abcdef" })` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"INVALID_PHONE"`

---

### Requirement: Find Contact By Id

`findById` MUST return the contact if it exists and is not soft-deleted. Soft-deleted rows MUST be treated as non-existent.

#### Scenario: active contact found

- GIVEN a contact with `id = "uuid-1"` exists and `deleted_at` is null
- WHEN `findById("uuid-1")` is called
- THEN `result.ok` is `true`
- AND `result.value.id` is `"uuid-1"`

#### Scenario: soft-deleted contact → not found

- GIVEN a contact with `id = "uuid-2"` has `deleted_at` set
- WHEN `findById("uuid-2")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"CONTACT_NOT_FOUND"`

#### Scenario: id does not exist

- GIVEN no contact with `id = "uuid-999"` exists
- WHEN `findById("uuid-999")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"CONTACT_NOT_FOUND"`

---

### Requirement: List Contacts

`list` MUST return only active (non-deleted) contacts for the current tenant. Soft-deleted rows MUST be excluded. Results MUST be ordered by `created_at DESC` by default; callers MUST NOT rely on any other ordering unless a future `opts.orderBy` parameter is explicitly specified.

#### Scenario: returns only active contacts

- GIVEN 3 contacts exist: 2 active, 1 soft-deleted
- WHEN `list()` is called
- THEN `result.ok` is `true`
- AND `result.value` has exactly 2 entries
- AND none of the entries has `deleted_at` set

#### Scenario: empty list when no contacts

- GIVEN the current tenant has no contacts
- WHEN `list()` is called
- THEN `result.ok` is `true`
- AND `result.value` is `[]`

#### Scenario: list is ordered by created_at DESC

- GIVEN 3 active contacts created at times T1 < T2 < T3 (oldest to newest)
- WHEN `list()` is called
- THEN `result.ok` is `true`
- AND `result.value[0].createdAt` equals T3 (most recent first)
- AND `result.value[2].createdAt` equals T1 (oldest last)

---

### Requirement: Update Contact

`update` MUST patch only the provided fields, leave unspecified fields unchanged, and set `updated_at = now()`. Attempting to update a non-existent or soft-deleted contact MUST return `err({ code: 'CONTACT_NOT_FOUND' })`.

#### Scenario: partial update succeeds

- GIVEN a contact with `id = "uuid-1"` and `full_name = "Ana"` and `tags = []`
- WHEN `update("uuid-1", { full_name: "Ana García" })` is called
- THEN `result.ok` is `true`
- AND `result.value.full_name` is `"Ana García"`
- AND `result.value.tags` is `[]` (unchanged)
- AND `result.value.updated_at` is more recent than the original `updated_at`

#### Scenario: update soft-deleted contact → not found

- GIVEN contact `"uuid-2"` is soft-deleted
- WHEN `update("uuid-2", { full_name: "X" })` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"CONTACT_NOT_FOUND"`

---

### Requirement: Soft Delete Contact

`softDelete` MUST set `deleted_at = now()` for the target contact. Soft-deleting an already-deleted contact MUST be idempotent (returns `ok(void)`). Soft-deleting a non-existent id MUST return `err({ code: 'CONTACT_NOT_FOUND' })`.

#### Scenario: soft delete active contact

- GIVEN a contact with `id = "uuid-1"` and `deleted_at` null
- WHEN `softDelete("uuid-1")` is called
- THEN `result.ok` is `true`
- AND a subsequent `findById("uuid-1")` returns `CONTACT_NOT_FOUND`

#### Scenario: soft delete is idempotent on already-deleted contact

- GIVEN a contact with `id = "uuid-1"` already has `deleted_at` set
- WHEN `softDelete("uuid-1")` is called
- THEN `result.ok` is `true`

#### Scenario: soft delete non-existent id

- GIVEN no contact with `id = "uuid-999"` exists
- WHEN `softDelete("uuid-999")` is called
- THEN `result.ok` is `false`
- AND `result.error.code` is `"CONTACT_NOT_FOUND"`

---

## New Capability: contacts-crud-api

### Requirement: Result → HTTP Status Mapping

Every `ContactsRepositoryError` code MUST map to a specific HTTP status as follows. Routes MUST use this mapping exclusively; no ad-hoc status decisions are permitted.

| Domain error code | HTTP status | Response body key |
|------------------|-------------|-------------------|
| `CONTACT_ALREADY_EXISTS` | `409 Conflict` | `{ "error": "CONTACT_ALREADY_EXISTS" }` |
| `CONTACT_NOT_FOUND` | `404 Not Found` | `{ "error": "CONTACT_NOT_FOUND" }` |
| `INVALID_PHONE` | `422 Unprocessable Entity` | `{ "error": "INVALID_PHONE" }` |
| `DB_ERROR` | `500 Internal Server Error` | `{ "error": "INTERNAL_ERROR" }` |
| Zod validation failure | `400 Bad Request` | `{ "error": "VALIDATION_ERROR", "details": [...] }` |

---

### Requirement: POST /contacts — Create Contact

`POST /contacts` MUST accept a JSON body, validate via Zod, invoke `repository.create`, and return an HTTP response per the mapping table.

Request body schema:
```
{ phone: string (required), full_name?: string, source?: string, tags?: string[], intent?: string, intent_confidence?: number }
```

#### Scenario: create succeeds → 201

- GIVEN a valid request body `{ "phone": "987654321", "full_name": "Ana" }` and tenant header set
- WHEN `POST /contacts` is called
- THEN the response status is `201`
- AND the response body contains the created contact with `phone_e164: "+51987654321"`

#### Scenario: phone already exists → 409

- GIVEN a live contact with `phone_e164 = "+51987654321"` already exists
- WHEN `POST /contacts` with `{ "phone": "+51987654321" }` is called
- THEN the response status is `409`
- AND the body is `{ "error": "CONTACT_ALREADY_EXISTS" }`

#### Scenario: invalid phone format → 422

- GIVEN request body `{ "phone": "abcdef" }`
- WHEN `POST /contacts` is called
- THEN the response status is `422`
- AND the body is `{ "error": "INVALID_PHONE" }`

#### Scenario: missing required field → 400

- GIVEN request body `{}` (no phone field)
- WHEN `POST /contacts` is called
- THEN the response status is `400`
- AND the body contains `{ "error": "VALIDATION_ERROR" }`

---

### Requirement: GET /contacts — List Contacts

`GET /contacts` MUST return all active contacts for the current tenant as a JSON array, ordered by `created_at DESC`.

#### Scenario: list returns active contacts

- GIVEN 2 active contacts exist for the current tenant
- WHEN `GET /contacts` is called with valid tenant header
- THEN the response status is `200`
- AND the body is `{ "data": [ <contact>, <contact> ] }`
- AND no soft-deleted contacts are included

#### Scenario: empty list

- GIVEN no active contacts exist for the current tenant
- WHEN `GET /contacts` is called
- THEN the response status is `200`
- AND the body is `{ "data": [] }`

---

### Requirement: GET /contacts/:id — Get Contact By Id

`GET /contacts/:id` MUST return the contact if found and active. If not found or soft-deleted, return 404.

#### Scenario: found → 200

- GIVEN contact `uuid-1` is active
- WHEN `GET /contacts/uuid-1` is called
- THEN the response status is `200`
- AND the body contains the contact object

#### Scenario: not found → 404

- GIVEN no active contact with `id = "uuid-999"` exists
- WHEN `GET /contacts/uuid-999` is called
- THEN the response status is `404`
- AND the body is `{ "error": "CONTACT_NOT_FOUND" }`

---

### Requirement: PATCH /contacts/:id — Update Contact

`PATCH /contacts/:id` MUST accept a partial JSON body (all fields optional), validate via Zod, invoke `repository.update`, and return the updated contact or an error.

Request body schema (all fields optional):
```
{ full_name?: string, source?: string, tags?: string[], intent?: string, intent_confidence?: number }
```

#### Scenario: update succeeds → 200

- GIVEN contact `uuid-1` is active
- WHEN `PATCH /contacts/uuid-1` with `{ "full_name": "Nueva" }` is called
- THEN the response status is `200`
- AND the body contains the updated contact with `full_name: "Nueva"`

#### Scenario: contact not found → 404

- GIVEN no active contact with `id = "uuid-999"` exists
- WHEN `PATCH /contacts/uuid-999` with any body is called
- THEN the response status is `404`

---

### Requirement: DELETE /contacts/:id — Soft Delete Contact

`DELETE /contacts/:id` MUST invoke `repository.softDelete` and return `204 No Content` on success.

#### Scenario: delete succeeds → 204

- GIVEN contact `uuid-1` is active
- WHEN `DELETE /contacts/uuid-1` is called
- THEN the response status is `204`
- AND a subsequent `GET /contacts/uuid-1` returns `404`

#### Scenario: contact not found → 404

- GIVEN no contact with `id = "uuid-999"` exists
- WHEN `DELETE /contacts/uuid-999` is called
- THEN the response status is `404`

---

## Extended Capability: contacts (merged from contacts-table-rls-crud)

### ADDED Requirement: Contact Domain Type

The contacts domain MUST define a `Contact` type representing a persisted contact record. All fields correspond directly to the `contacts` table columns. `deleted_at` is included in the type but MUST be `null` in all values returned from repository read operations (findById, list, update).

#### Scenario: Contact type is complete and matches table shape

- GIVEN the `Contact` type is defined in the contacts domain
- WHEN a contact is created and retrieved
- THEN it has: `id` (UUID string), `tenantId` (UUID string), `phoneE164` (E.164 string), `full_name` (string or null), `source` (string or null), `tags` (string[]), `intent` (string or null), `intentConfidence` (number or null), `createdAt` (Date), `updatedAt` (Date), `deletedAt` (Date or null)

---

## Out of Scope (Non-Requirements for This Slice: contacts-table-rls-crud)

- Real JWT authentication (dev-header mode only, prod-gated)
- `WHERE tenant_id` in any application query (RLS only)
- Bulk import or merge of duplicate contacts
- ContactLead routing to CRM
- Web UI
- Advanced pagination (cursor/offset beyond basic `list`)
- `contactLeadSchema.phone_e164` regex tightening
