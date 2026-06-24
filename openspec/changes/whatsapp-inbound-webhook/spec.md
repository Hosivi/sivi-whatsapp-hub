# Spec — whatsapp-inbound-webhook

> Change: whatsapp-inbound-webhook
> Domain: webhooks (new module — whatsapp-webhook, whatsapp-accounts, whatsapp-messages)
> Artifact store: hybrid

---

## Purpose

Define the observable behavior for the WhatsApp inbound webhook skeleton. This slice wires Meta's Cloud API verification handshake and inbound message ingestion into the Hub: verify signature (global key), resolve tenant by `phone_number_id`, upsert or reuse contact, and persist the raw message idempotently. No AI, no outbound, no reply. This spec describes WHAT must be true — not how it is implemented.

---

## Corrections Applied

| Correction | What changed |
|---|---|
| **Credential model = GLOBAL** | Dropped `app_secret` and `verify_token` columns from `whatsapp_accounts`. Signature is verified with the global env var `WHATSAPP_APP_SECRET` BEFORE tenant resolution. Happy-path scenario updated accordingly. |
| **`whatsapp_accounts` canonical shape** | Added `is_active BOOLEAN NOT NULL DEFAULT true`; added `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`; added `deleted_at TIMESTAMPTZ` (soft-delete); removed `app_secret` and `verify_token` columns. |
| **`whatsapp_messages` canonical shape** | `contact_id` is NOT NULL with FK to `contacts(id)` (was NULLABLE). Added `from_phone_e164 TEXT NOT NULL` (was NULLABLE). Added `text_body TEXT`. Removed `direction` column. |
| **Contact upsert-or-reuse** | A LIVE existing contact MUST resolve to its existing id (NOT an error). `upsertContactTx` semantics: live → reuse, soft-deleted → resurrect, new → insert. The `contact_id` is always set on the happy path. |
| **`app_webhook` grant is column-scoped** | `GRANT SELECT (phone_number_id, tenant_id)` only. `resolveTenant` MUST select those explicit columns — never `SELECT *`. Scenario updated to reflect column-scoped access. |

---

## New Capability: whatsapp-accounts

### Requirement: whatsapp_accounts Table Shape

The `whatsapp_accounts` table MUST be created with the following columns and constraints.

| Column | Type | Constraint |
|--------|------|-----------|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()`, NOT NULL |
| `tenant_id` | `UUID` | NOT NULL |
| `phone_number_id` | `TEXT` | NOT NULL, UNIQUE (partial: `WHERE deleted_at IS NULL`) |
| `display_phone_number` | `TEXT` | NOT NULL |
| `waba_id` | `TEXT` | NOT NULL |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |
| `deleted_at` | `TIMESTAMPTZ` | NULLABLE (soft-delete) |

There are NO `app_secret` or `verify_token` columns. Credentials are global env vars (`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`), not per-row.

Row-level security MUST be ENABLED and FORCED on the table. TWO permissive, role-scoped policies MUST exist:
- `tenant_isolation` TO `app_rls`: restricts all operations to rows where `tenant_id = current_setting('app.current_tenant')::uuid`.
- `webhook_config_read` TO `app_webhook` FOR SELECT: `USING(true)` — allows cross-tenant config reads by the lookup handle.

The migration MUST `GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_accounts TO app_rls`. The `app_webhook` role MUST receive a column-scoped grant only: `GRANT SELECT (phone_number_id, tenant_id) ON whatsapp_accounts TO app_webhook`.

#### Scenario: table exists with correct shape

- GIVEN the `0002_whatsapp.sql` migration has been applied
- WHEN the schema is introspected
- THEN `whatsapp_accounts` exists with columns: `id`, `tenant_id`, `phone_number_id`, `display_phone_number`, `waba_id`, `is_active`, `created_at`, `updated_at`, `deleted_at`
- AND there is NO `app_secret` column and NO `verify_token` column
- AND a partial UNIQUE index on `phone_number_id WHERE deleted_at IS NULL` is present
- AND RLS is enabled and forced on the table
- AND `app_rls` has SELECT, INSERT, UPDATE, DELETE grants

---

### Requirement: Low-Privilege Lookup Role

The system MUST provision a dedicated Postgres role `app_webhook` with `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`. The role MUST be granted ONLY `SELECT (phone_number_id, tenant_id)` on `whatsapp_accounts` — a column-scoped grant. No other table or column MAY be granted to `app_webhook`. This role MUST be used exclusively for the cross-tenant `phone_number_id → tenant_id` lookup. It MUST NOT be used for any write or for reading `whatsapp_messages` or `contacts`.

#### Scenario: app_webhook role reads only the granted columns of whatsapp_accounts

- GIVEN the migration has run
- WHEN connecting as `app_webhook` and querying `SELECT phone_number_id, tenant_id FROM whatsapp_accounts`
- THEN the query succeeds and returns rows across tenants (no tenant GUC required)
- AND `SELECT *` on `whatsapp_accounts` is denied (column grant forbids unlisted columns)
- AND SELECT on `whatsapp_messages` is denied (permission denied — no grant)
- AND SELECT on `contacts` is denied (permission denied — no grant)
- AND INSERT/UPDATE/DELETE on any table is denied

---

### Requirement: Tenant Resolution via phone_number_id

The system MUST resolve `tenant_id` from `phone_number_id` via the `app_webhook` lookup handle BEFORE any `withTenant` context is established. `resolveTenant` MUST select explicit columns `(phone_number_id, tenant_id)` — NEVER `SELECT *` (column grant restricts this). If no live row exists in `whatsapp_accounts` for a given `phone_number_id`, the lookup MUST return a not-found signal. This lookup MUST NOT bypass RLS on any other table and MUST NOT use `adminSql`.

#### Scenario: known phone_number_id resolves to tenant

- GIVEN a `whatsapp_accounts` row exists with `phone_number_id = '12345'` and `tenant_id = 'aaa...'`
- WHEN the lookup handle queries `SELECT phone_number_id, tenant_id FROM whatsapp_accounts` for `phone_number_id = '12345'`
- THEN `tenant_id = 'aaa...'` is returned

#### Scenario: unknown phone_number_id returns not-found

- GIVEN no `whatsapp_accounts` row exists with `phone_number_id = '99999'`
- WHEN the lookup handle queries for `phone_number_id = '99999'`
- THEN the result is `err(UNKNOWN_PHONE_NUMBER_ID)` and no row is returned

---

## New Capability: whatsapp-messages

### Requirement: whatsapp_messages Table Shape

The `whatsapp_messages` table MUST be created with the following columns and constraints.

| Column | Type | Constraint |
|--------|------|-----------|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()`, NOT NULL |
| `tenant_id` | `UUID` | NOT NULL |
| `wamid` | `TEXT` | NOT NULL, UNIQUE |
| `phone_number_id` | `TEXT` | NOT NULL |
| `contact_id` | `UUID` | NOT NULL, FK → `contacts(id)` |
| `from_phone_e164` | `TEXT` | NOT NULL |
| `message_type` | `TEXT` | NOT NULL |
| `text_body` | `TEXT` | NULLABLE |
| `raw_payload` | `JSONB` | NOT NULL |
| `received_at` | `TIMESTAMPTZ` | NOT NULL |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |

There is NO `direction` column. `contact_id` is NOT NULL (never nullable); the contact upsert always runs first. Row-level security MUST be ENABLED and FORCED on the table. A `tenant_isolation` policy TO `app_rls` MUST restrict SELECT, INSERT, UPDATE, DELETE to rows where `tenant_id = current_setting('app.current_tenant')::uuid`. The migration MUST `GRANT SELECT, INSERT ON whatsapp_messages TO app_rls`. The `app_webhook` role MUST NOT be granted any access to `whatsapp_messages` — no policy and no grant.

#### Scenario: table exists with correct shape

- GIVEN the `0002_whatsapp.sql` migration has been applied
- WHEN the schema is introspected
- THEN `whatsapp_messages` exists with columns: `id`, `tenant_id`, `wamid`, `phone_number_id`, `contact_id`, `from_phone_e164`, `message_type`, `text_body`, `raw_payload`, `received_at`, `created_at`
- AND there is NO `direction` column
- AND `contact_id` has a NOT NULL constraint and a FK to `contacts(id)`
- AND `from_phone_e164` is NOT NULL
- AND a UNIQUE index on `wamid` is present
- AND RLS is enabled and forced on the table
- AND `app_rls` has SELECT and INSERT grants
- AND `app_webhook` has no grants on this table

---

### Requirement: Idempotent Message Persistence

The system MUST persist each inbound message with `ON CONFLICT (wamid) DO NOTHING`. A re-delivered message with a `wamid` already in the table MUST produce no duplicate row and MUST NOT return an error to the caller.

#### Scenario: first delivery persists the row

- GIVEN no row exists for `wamid = 'wamid_abc'` under the current tenant
- WHEN the service inserts a message with that `wamid`
- THEN exactly one row exists in `whatsapp_messages` with `wamid = 'wamid_abc'`

#### Scenario: re-delivery of existing wamid produces no duplicate

- GIVEN a row already exists for `wamid = 'wamid_abc'` under the current tenant
- WHEN the service inserts again with the same `wamid` (ON CONFLICT DO NOTHING)
- THEN still exactly one row exists (no duplicate)
- AND the operation does not raise an error

---

### Requirement: Message Tenant Isolation

A message persisted under tenant A MUST NOT be visible under tenant B. RLS on `whatsapp_messages` enforces this; no `WHERE tenant_id` is permitted in application queries.

#### Scenario: tenant A message invisible to tenant B

- GIVEN a message is stored under tenant A
- WHEN the DB is queried as `app_rls` with `SET LOCAL app.current_tenant = '<tenant_B_id>'`
- AND `SELECT * FROM whatsapp_messages` is executed
- THEN zero rows are returned for tenant B
- AND the row is visible when queried under tenant A's context

---

## New Capability: whatsapp-webhook

### Requirement: GET /webhooks/whatsapp — Hub Verification Handshake

The system MUST expose `GET /webhooks/whatsapp`. When Meta sends `hub.mode=subscribe` with a matching `hub.verify_token` (compared against the global `WHATSAPP_VERIFY_TOKEN` env var), the endpoint MUST respond `200 OK` with the `hub.challenge` value as plain-text body. Any other case (wrong token, absent token, wrong mode) MUST respond `403 Forbidden`. No tenant middleware is applied to this route.

#### Scenario: valid subscribe + matching verify_token → 200 echo challenge

- GIVEN the env var `WHATSAPP_VERIFY_TOKEN = 'secret'`
- WHEN `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=abc123` is called
- THEN the response status is `200`
- AND the response body is the plain text `abc123`

#### Scenario: wrong verify_token → 403

- GIVEN the env var `WHATSAPP_VERIFY_TOKEN = 'secret'`
- WHEN `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123` is called
- THEN the response status is `403`

#### Scenario: absent verify_token → 403

- GIVEN the env var `WHATSAPP_VERIFY_TOKEN = 'secret'`
- WHEN `GET /webhooks/whatsapp?hub.mode=subscribe&hub.challenge=abc123` is called (no `hub.verify_token`)
- THEN the response status is `403`

---

### Requirement: POST /webhooks/whatsapp — Signature Verification

The system MUST verify the `X-Hub-Signature-256` header (HMAC-SHA256 over the raw request body, keyed by the global `WHATSAPP_APP_SECRET` env var) before processing any payload. Signature verification MUST occur BEFORE tenant resolution. The raw body MUST be read before any JSON parsing. A missing or mismatched signature MUST be logged and responded to with `200 OK` — never a non-200 status. No payload MUST be persisted when the signature is invalid.

The implementation MUST: strip the `sha256=` prefix, length-check both buffers before calling `crypto.timingSafeEqual` (which throws on length mismatch), and wrap the entire verify in try/catch so it NEVER throws out of the handler.

#### Scenario: valid signature (global WHATSAPP_APP_SECRET) proceeds to processing

- GIVEN a POST with `X-Hub-Signature-256` computed as HMAC-SHA256 over the raw body with the global `WHATSAPP_APP_SECRET`
- WHEN `POST /webhooks/whatsapp` is called
- THEN signature verification passes and processing continues to tenant resolution

#### Scenario: bad signature → logged, 200, nothing persisted

- GIVEN a POST with `X-Hub-Signature-256` containing an incorrect HMAC
- WHEN `POST /webhooks/whatsapp` is called
- THEN the response status is `200`
- AND no row is inserted in `whatsapp_messages`
- AND the event is logged at a warning/error level

#### Scenario: absent signature header → logged, 200, nothing persisted

- GIVEN a POST with no `X-Hub-Signature-256` header
- WHEN `POST /webhooks/whatsapp` is called
- THEN the response status is `200`
- AND no row is inserted in `whatsapp_messages`

---

### Requirement: POST /webhooks/whatsapp — Ack-Fast Contract

The system MUST return `200 OK` in ALL cases after POST: bad signature, unknown `phone_number_id`, status-only event, malformed payload, DB error, non-Peru phone, or successful persistence. The only exception to non-200 is the GET handshake which returns `403` on a bad verify token. This prevents Meta retry storms.

---

### Requirement: POST /webhooks/whatsapp — Payload Validation (Zod)

After signature verification, the raw body MUST be validated against the Meta webhook payload schema (Zod). An invalid or malformed payload MUST be logged and responded to with `200 OK`. No persistence occurs on Zod validation failure.

#### Scenario: malformed JSON body → logged, 200, nothing persisted

- GIVEN a correctly signed POST with body that is not valid JSON
- WHEN `POST /webhooks/whatsapp` is called
- THEN the response status is `200`
- AND no row is inserted in `whatsapp_messages`
- AND the event is logged

#### Scenario: valid JSON but Zod-invalid structure → logged, 200, nothing persisted

- GIVEN a correctly signed POST with JSON that does not match the Meta payload schema (e.g., missing `entry` array)
- WHEN `POST /webhooks/whatsapp` is called
- THEN the response status is `200`
- AND no row is inserted in `whatsapp_messages`

---

### Requirement: POST /webhooks/whatsapp — Status-Only Event Skip

When the incoming payload has `value.statuses` present but `value.messages` absent or empty, the system MUST respond `200 OK` without persisting any row. No contact upsert is performed.

#### Scenario: status-only event (no value.messages) → 200, nothing persisted

- GIVEN a correctly signed POST where `entry[0].changes[0].value` has `statuses: [...]` but no `messages` field (or `messages` is empty)
- WHEN `POST /webhooks/whatsapp` is called
- THEN the response status is `200`
- AND no row is inserted in `whatsapp_messages`
- AND no contact upsert is performed

---

### Requirement: POST /webhooks/whatsapp — Unknown phone_number_id

When a valid message payload arrives with a `phone_number_id` not found in `whatsapp_accounts`, the system MUST log the event and respond `200 OK`. No contact upsert and no message row are persisted.

#### Scenario: unknown phone_number_id → logged, 200, nothing persisted

- GIVEN no `whatsapp_accounts` row exists for `phone_number_id = '99999'`
- WHEN a correctly signed POST arrives with `metadata.phone_number_id = '99999'`
- THEN the response status is `200`
- AND no row is inserted in `whatsapp_messages`
- AND no contact upsert is performed
- AND the event is logged

---

### Requirement: POST /webhooks/whatsapp — Contact Upsert-or-Reuse

After tenant resolution, the system MUST normalize `message.from` (the sender `wa_id`) via `normalizePhoneE164`. On success, `upsertContactTx` MUST be called within the resolved `withTenant` transaction to upsert the contact. `upsertContactTx` MUST:
- Return `ok(existingContact)` when a LIVE contact already exists for that phone (reuse, not error).
- Resurrect a soft-deleted contact and return `ok(resurrectedContact)`.
- Insert a new contact and return `ok(newContact)`.

The `source` field MUST be set to `'whatsapp'`. The resulting `contact_id` MUST be set (NOT NULL) on the `whatsapp_messages` insert. A non-Peru `wa_id` that fails normalization MUST be logged and the entire POST responded to with `200 OK`; neither contact nor message row is persisted.

The existing `contacts.create()` public contract MUST NOT change: it MUST still return `err(CONTACT_ALREADY_EXISTS)` when a live duplicate exists (so existing integration tests pass without modification).

#### Scenario: new Peru wa_id → contact created, message persisted with contact_id

- GIVEN a known `phone_number_id` resolves to tenant A
- AND no contact exists for `message.from = '51987654321'`
- WHEN a correctly signed POST is processed
- THEN `normalizePhoneE164` returns `ok('+51987654321')`
- AND `upsertContactTx` inserts a new contact with `source = 'whatsapp'` and returns `ok(newContact)`
- AND a row is inserted in `whatsapp_messages` with `contact_id = newContact.id` (NOT NULL)

#### Scenario: existing live contact for same phone → reused, message persisted with contact_id

- GIVEN a known `phone_number_id` resolves to tenant A
- AND a LIVE contact already exists for `phone_e164 = '+51987654321'` with `id = 'existing_uuid'`
- WHEN a correctly signed POST is processed
- THEN `upsertContactTx` returns `ok(existingContact)` (no error, no duplicate row)
- AND a row is inserted in `whatsapp_messages` with `contact_id = 'existing_uuid'` (NOT NULL)

#### Scenario: non-Peru wa_id fails normalization → logged, 200, nothing persisted

- GIVEN a known `phone_number_id` resolves to tenant A
- AND `message.from = '1234567890'` (non-Peru, fails `normalizePhoneE164`)
- WHEN a correctly signed POST is processed
- THEN the response status is `200`
- AND no row is inserted in `contacts` for this phone
- AND no row is inserted in `whatsapp_messages`
- AND the normalization failure is logged

---

### Requirement: POST /webhooks/whatsapp — Happy Path End-to-End

A fully valid inbound message MUST result in: global signature verified, tenant resolved, contact upserted or reused (contact_id NOT NULL), message row inserted with `contact_id` FK, raw payload stored in `raw_payload` JSONB, and `200 OK` returned.

#### Scenario: valid signed POST with Peru wa_id and known phone_number_id → full persistence, 200

- GIVEN `whatsapp_accounts` has a row for `phone_number_id = '111'` linked to tenant A
- AND the POST body is signed with the global `WHATSAPP_APP_SECRET`
- AND the payload contains a text message from `from = '51987654321'` with `wamid = 'wamid_001'`
- WHEN `POST /webhooks/whatsapp` is called
- THEN the response status is `200`
- AND a contact exists (or is reused) in `contacts` for `phone_e164 = '+51987654321'` under tenant A
- AND exactly one row exists in `whatsapp_messages` with `wamid = 'wamid_001'`, `contact_id` NOT NULL (FK to the contact), `raw_payload` containing the original message object
- AND no `WHERE tenant_id` clause was used — RLS via `withTenant` only

---

### Requirement: POST /webhooks/whatsapp — DB Error Resilience

If a DB error occurs during contact upsert or message insert, the system MUST log the error and respond `200 OK`. No partial state is acceptable; a transaction rollback MUST ensure the message row is NOT persisted if the operation fails partway. Both the contact upsert and message insert run in a SINGLE `withTenant` transaction.

#### Scenario: DB error during persistence → logged, 200, no partial state

- GIVEN a valid signed POST with a known tenant and valid Peru phone
- WHEN a simulated DB failure occurs during the insert (e.g., connection timeout)
- THEN the response status is `200`
- AND no partial `whatsapp_messages` row exists for this `wamid`
- AND no orphaned contact row is left from the failed transaction
- AND the error is logged

---

### Requirement: Webhook Route Isolation

The webhook router (`/webhooks/whatsapp`) MUST be mounted in the app WITHOUT the tenant middleware. It MUST NOT share middleware configuration with the `/contacts` router. Existing `contacts.route.ts` and `contacts-tags-intent` module MUST remain untouched.

---

## Out of Scope (Non-Requirements for This Slice)

- AI response, auto-reply, outbound messages, or templates.
- Media download or processing.
- Conversations table or conversation threading.
- `status[]` event processing beyond the early-200 skip.
- Non-Peru number support.
- Broadcasts, payments, SUNAT, appointments, UI.
- Any change to `contacts.route.ts` or the contacts-tags-intent module.
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
- Per-tenant Meta App Secret or verify_token (forward-compat: out of scope until multi-Meta-App / Tech-Provider scenario).
