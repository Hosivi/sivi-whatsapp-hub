# Spec — whatsapp-webhook

> **Domain**: webhooks (new module — whatsapp-webhook, whatsapp-accounts, whatsapp-messages)
> **Scope**: Corte 2 skeleton — inbound message ingestion from Meta Cloud API
> **Last Updated**: 2026-06-25 (whatsapp-outbound merged: access_token + direction)

---

## Purpose

Define the observable behavior for the WhatsApp inbound webhook skeleton. This slice wires Meta's Cloud API verification handshake and inbound message ingestion into the Hub: verify signature (global key), resolve tenant by `phone_number_id`, upsert or reuse contact, and persist the raw message idempotently. No AI, no outbound, no reply. This spec describes WHAT must be true — not how it is implemented.

---

## Canonical Table Shapes

### whatsapp_accounts

Configuration table: tenant ↔ WhatsApp phone number mapping.

| Column | Type | Constraint |
|--------|------|-----------|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()`, NOT NULL |
| `tenant_id` | `UUID` | NOT NULL |
| `phone_number_id` | `TEXT` | NOT NULL, UNIQUE (partial: `WHERE deleted_at IS NULL`) |
| `display_phone_number` | `TEXT` | NOT NULL |
| `waba_id` | `TEXT` | NOT NULL |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` |
| `access_token` | `TEXT` | NULLABLE |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |
| `deleted_at` | `TIMESTAMPTZ` | NULLABLE (soft-delete) |

**RLS**: ENABLED and FORCED. Two permissive, role-scoped policies:
- `tenant_isolation` TO `app_rls`: restricts all operations to rows where `tenant_id = current_setting('app.current_tenant')::uuid`.
- `webhook_config_read` TO `app_webhook` FOR SELECT: `USING(true)` — allows cross-tenant config reads by the lookup handle.

**Grants**:
- `app_rls`: SELECT, INSERT, UPDATE, DELETE (table-level; covers `access_token`)
- `app_webhook`: SELECT (phone_number_id, tenant_id) — column-scoped; `access_token` is NOT included

**Notes**:
- NO `app_secret` or `verify_token` columns. Credentials are global env vars (`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`), not per-row.
- `is_active` is included (forward-compat for deactivating a number without soft-delete).
- `access_token` holds the per-tenant Meta System User Bearer token (NULL = outbound not configured). It MUST NOT appear in any log line, API response, or trace at any level.

### whatsapp_messages

Inbound message persistence table.

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
| `direction` | `TEXT` | NOT NULL, DEFAULT `'inbound'` |
| `received_at` | `TIMESTAMPTZ` | NOT NULL |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` |

**RLS**: ENABLED and FORCED. Single policy:
- `tenant_isolation` TO `app_rls`: restricts SELECT, INSERT, UPDATE, DELETE to rows where `tenant_id = current_setting('app.current_tenant')::uuid`.

**Grants**:
- `app_rls`: SELECT, INSERT
- `app_webhook`: NO policy and NO grant (forbidden cross-tenant access to messages)

**Notes**:
- `direction` discriminates inbound (`'inbound'`, default) from outbound (`'outbound'`) rows. Existing inbound rows receive `direction = 'inbound'` via the column default — no explicit backfill required. Added via migration `0003_outbound.sql`.
- `contact_id` is NOT NULL for both directions: the contact upsert (`upsertContactTx`) always runs first. For outbound rows it is keyed by the recipient phone (`to`). For inbound rows it is keyed by the sender phone (`message.from`).
- `from_phone_e164` holds the CONTACT/RECIPIENT phone for both directions.
- `received_at` carries the SEND timestamp for outbound rows.
- `wamid` is globally unique (per Meta spec — prevents cross-tenant collisions naturally).

---

## New Capability: whatsapp-accounts

### Requirement: whatsapp_accounts Table Shape

The `whatsapp_accounts` table MUST be created with the columns and constraints shown above.

#### Scenario: table exists with correct shape

- GIVEN the `0002_whatsapp.sql` and `0003_outbound.sql` migrations have been applied
- WHEN the schema is introspected
- THEN `whatsapp_accounts` exists with all required columns including `access_token TEXT` (nullable)
- AND there is NO `app_secret` column and NO `verify_token` column
- AND a partial UNIQUE index on `phone_number_id WHERE deleted_at IS NULL` is present
- AND RLS is enabled and forced on the table
- AND `app_rls` has SELECT, INSERT, UPDATE, DELETE grants (covering `access_token`)
- AND `app_webhook` has SELECT (phone_number_id, tenant_id) grant only (`access_token` excluded)

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

The system MUST resolve `tenant_id` from `phone_number_id` via the `app_webhook` lookup handle BEFORE any `withTenant` context is established. The lookup MUST select explicit columns `(phone_number_id, tenant_id)` — NEVER `SELECT *` (column grant restricts this). If no live row exists in `whatsapp_accounts` for a given `phone_number_id`, the lookup MUST return a not-found signal. This lookup MUST NOT bypass RLS on any other table and MUST NOT use `adminSql`.

#### Scenario: known phone_number_id resolves to tenant

- GIVEN a `whatsapp_accounts` row exists with `phone_number_id = '12345'` and `tenant_id = 'aaa...'`
- WHEN the lookup handle queries for `phone_number_id = '12345'`
- THEN `tenant_id = 'aaa...'` is returned

#### Scenario: unknown phone_number_id returns not-found

- GIVEN no `whatsapp_accounts` row exists with `phone_number_id = '99999'`
- WHEN the lookup handle queries for `phone_number_id = '99999'`
- THEN the result is `err(UNKNOWN_PHONE_NUMBER_ID)` and no row is returned

---

### Requirement: access_token Column

The `whatsapp_accounts` table MUST have a nullable `access_token TEXT` column
(added via migration `0003_outbound.sql`). The column MUST default to `NULL`
(not configured). The existing `tenant_isolation` RLS policy on `app_rls` covers
this column through the table-level SELECT, INSERT, UPDATE, DELETE grants — no
additional policy is needed.

The `access_token` value represents a Meta System User permanent Bearer token
(non-expiring but revocable). It MUST NOT appear in any log line, API response,
or trace at any level.

#### Scenario: migration adds access_token column as nullable

- GIVEN `0002_whatsapp.sql` has been applied (no `access_token` column)
- WHEN `0003_outbound.sql` is applied
- THEN `whatsapp_accounts` gains an `access_token TEXT` column with no NOT NULL constraint
- AND existing rows have `access_token = NULL` (no backfill for live data)

#### Scenario: existing app_rls grants cover access_token without change

- GIVEN the migration has applied the new column
- WHEN querying `whatsapp_accounts` as `app_rls` under a valid tenant context
- THEN `access_token` is readable and writable without any additional grant
- AND `app_webhook` cannot read `access_token` (column-scoped grant does NOT include it)

---

### Requirement: app_webhook Role Exclusion from access_token

The `app_webhook` role's existing column-scoped grant
(`SELECT (phone_number_id, tenant_id)`) MUST NOT be expanded to include
`access_token`. The token MUST remain inaccessible to the low-privilege webhook
lookup role.

#### Scenario: app_webhook cannot read access_token

- GIVEN the migration has run
- WHEN connecting as `app_webhook` and executing
  `SELECT access_token FROM whatsapp_accounts`
- THEN the query is denied (column permission error)

---

### Requirement: Dev Seed access_token Backfill

`seed-dev.ts` MUST insert (or upsert) the dev `whatsapp_accounts` row with
`access_token = 'dev-access-token'` (a placeholder, not a real Meta token).
This allows the dev path to exercise the full outbound flow end-to-end against
the fake Meta client without requiring a real token.

Repeated runs MUST be idempotent — no duplicate rows, no error.

#### Scenario: dev seed sets access_token placeholder

- GIVEN the dev seed has been run
- WHEN querying the dev `whatsapp_accounts` row
- THEN `access_token = 'dev-access-token'`
- AND `deleted_at` is NULL (row is live)

#### Scenario: repeated seed runs remain idempotent

- GIVEN the dev seed has been run once
- WHEN `seed-dev.ts` is executed again
- THEN still exactly one row exists with `access_token = 'dev-access-token'`
- AND the script exits without error

---

## New Capability: whatsapp-messages

### Requirement: whatsapp_messages Table Shape

The `whatsapp_messages` table MUST be created with the columns and constraints shown above.

#### Scenario: table exists with correct shape

- GIVEN the `0002_whatsapp.sql` and `0003_outbound.sql` migrations have been applied
- WHEN the schema is introspected
- THEN `whatsapp_messages` exists with all required columns including `direction TEXT NOT NULL DEFAULT 'inbound'`
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

### Requirement: direction Column

The `whatsapp_messages` table MUST have a `direction TEXT NOT NULL DEFAULT 'inbound'` column
(added via migration `0003_outbound.sql`).

- All existing rows MUST inherit `direction = 'inbound'` via the column default
  (no explicit backfill required; Postgres applies the default to existing rows
  when a non-nullable column with a default is added via `ALTER TABLE ... ADD COLUMN`).
- Inbound rows written by `POST /webhooks/whatsapp` do NOT need to set `direction`
  explicitly — the default is applied automatically.
- Outbound rows written by `POST /whatsapp-send` MUST set `direction = 'outbound'`
  explicitly.

#### Scenario: migration adds direction column with default 'inbound'

- GIVEN `0002_whatsapp.sql` has been applied (no `direction` column)
- WHEN `0003_outbound.sql` is applied
- THEN `whatsapp_messages` gains a `direction TEXT NOT NULL DEFAULT 'inbound'` column
- AND all pre-existing inbound rows have `direction = 'inbound'`

#### Scenario: existing inbound INSERT behavior unchanged (direction defaults)

- GIVEN the migration has been applied
- WHEN `POST /webhooks/whatsapp` processes a valid inbound message (no `direction` set explicitly)
- THEN the persisted row has `direction = 'inbound'`
- AND all previously tested inbound scenarios still hold

---

### Requirement: Outbound Row Shape

When `POST /whatsapp-send` persists a successful send, the resulting
`whatsapp_messages` row MUST have:

| Field | Value |
|-------|-------|
| `direction` | `'outbound'` |
| `wamid` | the `id` value from Meta's response (`messages[0].id`) |
| `from_phone_e164` | the `to` field from the request body (recipient phone) |
| `phone_number_id` | the `phone_number_id` from the resolved `whatsapp_accounts` row |
| `message_type` | `'text'` |
| `text_body` | the `text` field from the request body |
| `raw_payload` | the Meta API response body (JSONB) |
| `received_at` | timestamp at the time of send |
| `contact_id` | the recipient contact, resolved via the shared contact upsert (NOT NULL) |

#### Scenario: outbound row has correct direction and wamid

- GIVEN `POST /whatsapp-send` succeeds with Meta returning `wamid = 'wamid_out_001'`
- WHEN the row is read back from `whatsapp_messages` under tenant A's context
- THEN `direction = 'outbound'`
- AND `wamid = 'wamid_out_001'`
- AND `from_phone_e164` equals the `to` value from the request body

---

### Requirement: direction Column — Inbound/Outbound Segregation

A query filtered on `direction = 'inbound'` MUST return only inbound rows. A
query filtered on `direction = 'outbound'` MUST return only outbound rows. Both
queries MUST rely on RLS via `withTenant` — no `WHERE tenant_id`.

#### Scenario: filtering by direction returns correct subset

- GIVEN tenant A has one inbound row (`direction = 'inbound'`) and one outbound row (`direction = 'outbound'`)
- WHEN `whatsapp_messages` is queried with `direction = 'inbound'` under tenant A's context
- THEN exactly one row is returned (the inbound row)

- WHEN `whatsapp_messages` is queried with `direction = 'outbound'` under tenant A's context
- THEN exactly one row is returned (the outbound row)

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
- AND the event is logged

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
