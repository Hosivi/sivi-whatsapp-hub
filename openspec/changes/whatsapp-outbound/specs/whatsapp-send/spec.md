# Spec — whatsapp-send (delta)

> Change: whatsapp-outbound
> Domain: whatsapp-send (NEW capability — outbound send primitive)
> Artifact store: hybrid
> Marker: ADDED

---

## Purpose

Define the observable behavior for the first outbound send primitive.
`POST /whatsapp-send` accepts `{ to, text }` under a tenant context, resolves the
tenant's single active WhatsApp account, calls the Meta Cloud API, persists an
outbound message row, and returns the Meta-assigned `wamid`.
This spec describes WHAT must be true — not how it is implemented.

---

## Requirements

### Requirement: POST /whatsapp-send — Tenant Middleware

The route MUST require the `X-Tenant-Id` header through the standard
`createTenantMiddleware`. A request missing `X-Tenant-Id` MUST be rejected with
`401 Unauthorized` before body validation occurs. The middleware MUST use the
same `withTenant`/`app_rls` pattern as `/contacts` and `/whatsapp-messages` —
never an explicit `WHERE tenant_id`.

#### Scenario: missing X-Tenant-Id → 401

- GIVEN `POST /whatsapp-send` is called without the `X-Tenant-Id` header
- WHEN the request is received by the server
- THEN the response status is `401`
- AND no DB read or Meta call is made

---

### Requirement: POST /whatsapp-send — Body Validation (Zod)

The request body MUST be validated by a Zod schema requiring:
- `to`: non-empty string in E.164 format (e.g. `+51987654321`).
- `text`: non-empty string.

Any body that fails this schema MUST be rejected with `422 Unprocessable Entity`
and a `VALIDATION_ERROR` code. The failure MUST occur before any DB or Meta
client call.

#### Scenario: missing `to` field → 422

- GIVEN `X-Tenant-Id` is provided
- WHEN `POST /whatsapp-send` is called with body `{ "text": "Hola" }` (no `to`)
- THEN the response status is `422`
- AND the response body contains a `VALIDATION_ERROR` code
- AND no DB read or Meta call is made

#### Scenario: empty `text` field → 422

- GIVEN `X-Tenant-Id` is provided
- WHEN `POST /whatsapp-send` is called with body `{ "to": "+51987654321", "text": "" }`
- THEN the response status is `422`
- AND the response body contains a `VALIDATION_ERROR` code

#### Scenario: non-E.164 `to` field → 422

- GIVEN `X-Tenant-Id` is provided
- WHEN `POST /whatsapp-send` is called with body `{ "to": "987654321", "text": "Hola" }` (no leading `+`)
- THEN the response status is `422`
- AND the response body contains a `VALIDATION_ERROR` code

---

### Requirement: POST /whatsapp-send — Single Active Account Resolution

After body validation, the service MUST use `withTenant` to select the tenant's
single active `whatsapp_accounts` row (`is_active = true AND deleted_at IS NULL`).
The query MUST rely on RLS (`app_rls` role + `withTenant` context) — NEVER an
explicit `WHERE tenant_id` clause.

If zero active rows are found, the service MUST return `NO_ACTIVE_ACCOUNT` and
the route MUST respond `404 Not Found`.

If more than one active row exists (misconfiguration), the service MUST return
an explicit error — it MUST NOT silently pick the first row. The route MUST
respond `422 Unprocessable Entity`.

#### Scenario: no active account → 404

- GIVEN tenant A has no rows in `whatsapp_accounts` with `is_active = true AND deleted_at IS NULL`
- WHEN `POST /whatsapp-send` is called with `X-Tenant-Id: <tenant-A-uuid>` and valid body
- THEN the response status is `404`
- AND the response body contains a `NO_ACTIVE_ACCOUNT` code
- AND no Meta client call is made

#### Scenario: multiple active accounts → 422

- GIVEN tenant A has two rows in `whatsapp_accounts` both with `is_active = true AND deleted_at IS NULL`
- WHEN `POST /whatsapp-send` is called with `X-Tenant-Id: <tenant-A-uuid>` and valid body
- THEN the response status is `422`
- AND no Meta client call is made

#### Scenario: soft-deleted account is excluded from resolution

- GIVEN tenant A has one row with `deleted_at IS NOT NULL` (soft-deleted) and no live active row
- WHEN `POST /whatsapp-send` is called
- THEN the response status is `404` (`NO_ACTIVE_ACCOUNT`)

---

### Requirement: POST /whatsapp-send — NULL Token Detection

If the resolved `whatsapp_accounts` row has `access_token IS NULL`, the service
MUST return `OUTBOUND_NOT_CONFIGURED` and the route MUST respond
`422 Unprocessable Entity`. The token value MUST NOT appear in any log line,
error response, or trace. No Meta client call is made.

#### Scenario: access_token is NULL → 422 OUTBOUND_NOT_CONFIGURED

- GIVEN tenant A has one active `whatsapp_accounts` row with `access_token = NULL`
- WHEN `POST /whatsapp-send` is called with valid body
- THEN the response status is `422`
- AND the response body contains an `OUTBOUND_NOT_CONFIGURED` code
- AND no Meta client call is made

---

### Requirement: POST /whatsapp-send — Meta Client Invocation

When a valid body, a single active account, and a non-NULL token are all present,
the service MUST call `metaClient.sendText({ phoneNumberId, accessToken, to, text })`
exactly once. The `accessToken` value MUST NOT be logged or returned in any
response at any log level.

#### Scenario: valid state calls Meta client exactly once

- GIVEN tenant A has one active account with a non-NULL `access_token`
- AND `POST /whatsapp-send` is called with valid body `{ to: "+51987654321", text: "Hola" }`
- WHEN the service executes
- THEN `metaClient.sendText` is called once with `phoneNumberId` from the account row, `accessToken` from the account row, `to = "+51987654321"`, and `text = "Hola"`

---

### Requirement: POST /whatsapp-send — Outbound Persistence on Success

On a successful Meta response, the service MUST resolve the recipient contact by
reusing the shared contact upsert (`upsertContactTx` — the same routine the
inbound webhook uses) keyed by the recipient phone, then insert exactly one row
into `whatsapp_messages` with:
- `direction = 'outbound'`
- `wamid` = the `wamid` returned by Meta
- `contact_id` = the upserted recipient contact (NOT NULL)
- `from_phone_e164` = the `to` value from the request body (the recipient's phone)
- `received_at` = the send timestamp
- `phone_number_id` = the account's `phone_number_id`

The Meta API call MUST NOT run inside a database transaction — no DB transaction
may be held open across the network round-trip. The account read is one short
`withTenant` operation; the contact upsert + message insert form a second short
`withTenant` write transaction executed AFTER Meta responds successfully. No
`WHERE tenant_id` is permitted — RLS via `withTenant` is the sole enforcement on
every operation.

If the persistence transaction fails AFTER Meta has already accepted the message,
the service MUST return `DB_ERROR` and the route MUST respond `500` — the send is
NOT rolled back (the message was already sent; this is an accepted at-least-once
tradeoff for this slice).

The route MUST respond `200 OK` with `{ wamid, status }` where `wamid` matches
the persisted row.

#### Scenario: successful send → 200 with wamid, outbound row persisted

- GIVEN tenant A has one active account with `phone_number_id = 'pnid_001'` and non-NULL `access_token`
- AND the Meta client returns `ok({ wamid: 'wamid_out_001', status: 'sent' })`
- WHEN `POST /whatsapp-send` is called with body `{ "to": "+51987654321", "text": "Hola" }`
- THEN the response status is `200`
- AND the response body is `{ "wamid": "wamid_out_001", "status": "sent" }`
- AND exactly one row exists in `whatsapp_messages` with `wamid = 'wamid_out_001'`, `direction = 'outbound'`, `from_phone_e164 = '+51987654321'`
- AND the persisted row has a non-NULL `contact_id` resolved for the recipient `+51987654321`
- AND no `WHERE tenant_id` clause was used — RLS via `withTenant` only

---

### Requirement: POST /whatsapp-send — Meta Error Mapping

When the Meta client returns an error, the service MUST map it to a typed domain
error according to this table and MUST NOT persist any `whatsapp_messages` row:

| Meta condition | Domain error | HTTP status |
|---|---|---|
| `metaCode === 131047` | `WINDOW_CLOSED` | `422` |
| Any other Meta error code | `META_API_ERROR` | `502` |
| Network / transport failure (no HTTP response) | `NETWORK_ERROR` | `502` or `503` |

Meta error `131047` MUST be surfaced as `WINDOW_CLOSED` and MUST NOT be
auto-retried. The real Meta error code and message MAY be included in a
structured log, but MUST NOT be returned in the API response body verbatim.

#### Scenario: Meta 131047 → 422 WINDOW_CLOSED, nothing persisted

- GIVEN a valid request and active account
- AND the Meta client returns `err({ metaCode: 131047, ... })`
- WHEN the service processes the response
- THEN the response status is `422`
- AND the response body contains a `WINDOW_CLOSED` code
- AND no row is inserted in `whatsapp_messages`

#### Scenario: other Meta error code → 502 META_API_ERROR, nothing persisted

- GIVEN a valid request and active account
- AND the Meta client returns `err({ metaCode: 190, ... })` (e.g. invalid token)
- WHEN the service processes the response
- THEN the response status is `502`
- AND the response body contains a `META_API_ERROR` code
- AND no row is inserted in `whatsapp_messages`

#### Scenario: network failure → 502/503 NETWORK_ERROR, nothing persisted

- GIVEN a valid request and active account
- AND the Meta client returns `err({ kind: 'network', ... })` (transport-level failure)
- WHEN the service processes the response
- THEN the response status is `502` or `503`
- AND the response body contains a `NETWORK_ERROR` code
- AND no row is inserted in `whatsapp_messages`

---

### Requirement: POST /whatsapp-send — RLS Tenant Isolation

An outbound message persisted by tenant A MUST NOT be visible when queried under
tenant B. This is enforced solely by RLS — no `WHERE tenant_id` in application
code.

#### Scenario: tenant A outbound row invisible to tenant B

- GIVEN `POST /whatsapp-send` is called with `X-Tenant-Id: <tenant-A-uuid>` and succeeds
- WHEN `whatsapp_messages` is queried as `app_rls` with `SET LOCAL app.current_tenant = '<tenant-B-uuid>'`
- THEN zero rows with `direction = 'outbound'` for tenant A are returned
- AND the row is visible when queried under tenant A's context

---

### Requirement: POST /whatsapp-send — Result Discipline (No Throws in Domain)

The service layer MUST return `Result<{ wamid, status }, WhatsappSendError>` and
MUST NOT throw for any business-logic or Meta-API error. Only infrastructure
layer code (real HTTP fetch) may throw; those throws MUST be caught at the
boundary and converted to a `NETWORK_ERROR` result. The route maps the result
union to HTTP codes.

---

## Out of Scope (Non-Requirements for This Slice)

- Template (HSM) messages.
- AI-triggered or auto-echo sends.
- 24h-window pre-validation; `131047` is surfaced, not pre-checked.
- Token encryption at rest.
- Delivery-status tracking from Meta status webhooks.
- Multiple WhatsApp accounts per tenant.
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
