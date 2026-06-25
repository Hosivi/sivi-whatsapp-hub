# Spec — dev-console

> **Domain**: dev-console (new capability — dev-only inbound simulation console)
> **Scope**: whatsapp-inbound-test-ui — exercise the full WhatsApp inbound reception path end-to-end without a real Meta callback
> **Last Updated**: 2026-06-24 (post-verify, canonical merged spec)

---

## Purpose

Define the observable behavior for the dev-only inbound simulation console.
This slice adds a signing proxy, a message read-back endpoint, a dev seed, env/CORS
gating, and a Next.js 15 web page that lets a developer exercise the full
WhatsApp inbound reception path end-to-end without a real Meta callback.
Specs describe WHAT must be true, not HOW it is implemented.

---

## Requirements

### Requirement: Dev Endpoint Guard

The system MUST mount dev-only routes (`POST /dev/webhook-sign`) and permissive
CORS ONLY when the environment variable `ENABLE_DEV_ENDPOINTS` is `"true"`.
When `ENABLE_DEV_ENDPOINTS` is absent, `"false"`, or any other value, the routes
MUST NOT be registered and any direct request to them MUST receive `404 Not Found`.
The guard MUST be checked at server startup, not per-request.

#### Scenario: dev endpoints inactive by default

- GIVEN `ENABLE_DEV_ENDPOINTS` is not set (or set to `"false"`)
- WHEN `POST /dev/webhook-sign` is called
- THEN the response status is `404`

#### Scenario: dev endpoints active when flag is true

- GIVEN `ENABLE_DEV_ENDPOINTS=true`
- WHEN the backend starts
- THEN `POST /dev/webhook-sign` is registered and reachable

---

### Requirement: Dev CORS Gating

When `ENABLE_DEV_ENDPOINTS=true`, the backend MUST add a CORS middleware that
permits the `apps/web` origin (`http://localhost:3000`) to call `POST /dev/webhook-sign`
and `GET /whatsapp-messages`.
When `ENABLE_DEV_ENDPOINTS` is not `"true"`, no permissive CORS headers are added.

#### Scenario: CORS headers present when dev flag is on

- GIVEN `ENABLE_DEV_ENDPOINTS=true`
- WHEN `OPTIONS http://localhost:3001/dev/webhook-sign` is called with `Origin: http://localhost:3000`
- THEN the response includes `Access-Control-Allow-Origin: http://localhost:3000`

#### Scenario: CORS headers absent when dev flag is off

- GIVEN `ENABLE_DEV_ENDPOINTS` is not set
- WHEN any request is made with `Origin: http://localhost:3000`
- THEN no permissive `Access-Control-Allow-Origin` header is returned

---

### Requirement: POST /dev/webhook-sign — Signing Proxy

The endpoint MUST accept a JSON body with fields `phone` (E.164 string), `profileName`
(string, optional), and `text` (string). It MUST:

1. Build a Meta-shaped payload (matching the `metaPayloadSchema`) using the provided
   fields plus `phone_number_id` from the dev seed config.
2. Generate a unique `wamid` per call (MUST NOT reuse a previous call's wamid).
3. Compute `X-Hub-Signature-256` as `sha256=<HMAC-SHA256(rawBody, WHATSAPP_APP_SECRET)>`.
4. Return `200` with a JSON body: `{ payload, signature }` where `payload` is the
   constructed Meta JSON object and `signature` is the computed header value.

The `WHATSAPP_APP_SECRET` MUST NOT be returned in the response and MUST NOT be
logged at any level.

#### Scenario: happy path — returns signed payload with unique wamid

- GIVEN `ENABLE_DEV_ENDPOINTS=true` and `WHATSAPP_APP_SECRET` is set
- WHEN `POST /dev/webhook-sign` is called with `{ phone: "+51987654321", profileName: "Test User", text: "Hola" }`
- THEN the response status is `200`
- AND the body contains `payload` matching the Meta webhook schema (entry, changes, value, messages array)
- AND the body contains `signature` starting with `sha256=`
- AND `payload.entry[0].changes[0].value.messages[0].id` is a non-empty string
- AND `WHATSAPP_APP_SECRET` does not appear in the response body

#### Scenario: wamid is unique across consecutive calls

- GIVEN `ENABLE_DEV_ENDPOINTS=true`
- WHEN `POST /dev/webhook-sign` is called twice with identical inputs
- THEN the `wamid` in the first response differs from the `wamid` in the second response

#### Scenario: missing required field returns 400

- GIVEN `ENABLE_DEV_ENDPOINTS=true`
- WHEN `POST /dev/webhook-sign` is called without the `text` field
- THEN the response status is `400`

---

### Requirement: GET /whatsapp-messages — Tenant-Scoped Read-Back

The system MUST expose `GET /whatsapp-messages` requiring the dev-header tenant
middleware (`X-Tenant-Id`). It MUST use the `app_rls` role + `withTenant` context
(mirroring `GET /contacts`). It MUST return persisted messages for the resolved
tenant ordered by `received_at` DESC. It MUST NOT use an explicit `WHERE tenant_id`
clause — RLS is the sole enforcement mechanism.

#### Scenario: returns messages for the current tenant ordered by received_at desc

- GIVEN a tenant has two messages with `received_at` timestamps T1 < T2
- WHEN `GET /whatsapp-messages` is called with `X-Tenant-Id: <tenant-uuid>`
- THEN the response status is `200`
- AND the response body contains both messages
- AND the message with timestamp T2 appears before the message with timestamp T1

#### Scenario: empty list when no messages exist for tenant

- GIVEN a tenant has no persisted messages
- WHEN `GET /whatsapp-messages` is called with `X-Tenant-Id: <tenant-uuid>`
- THEN the response status is `200`
- AND the response body is an empty array (or equivalent empty list)

#### Scenario: RLS isolation — tenant A cannot see tenant B messages

- GIVEN a message is persisted under tenant B
- WHEN `GET /whatsapp-messages` is called with `X-Tenant-Id: <tenant-A-uuid>`
- THEN the response body contains zero messages belonging to tenant B

#### Scenario: missing X-Tenant-Id returns 401

- GIVEN `ENABLE_DEV_ENDPOINTS=true`
- WHEN `GET /whatsapp-messages` is called without `X-Tenant-Id`
- THEN the response status is `401`

---

### Requirement: Dev Seed

`apps/backend/src/db/seed-dev.ts` MUST idempotently insert exactly one row into
`whatsapp_accounts` mapping a known `phone_number_id` to a known `tenant_id`.
The row MUST have `deleted_at = NULL` (live). Running the seed script multiple
times MUST NOT create duplicate rows and MUST NOT error.

#### Scenario: seed creates the whatsapp_accounts row on first run

- GIVEN no row exists for the seeded `phone_number_id`
- WHEN `seed-dev.ts` is executed
- THEN exactly one row exists in `whatsapp_accounts` with the configured `phone_number_id` and `tenant_id`
- AND `deleted_at` is NULL

#### Scenario: seed is idempotent on repeated runs

- GIVEN the seed has already been run once
- WHEN `seed-dev.ts` is executed again
- THEN still exactly one row exists for that `phone_number_id` (no duplicate)
- AND the script exits without error

---

### Requirement: Env Documentation

A file `.env.example` MUST exist at the repo root documenting ALL environment
variables required to run both the backend and `apps/web` in dev mode. It MUST
include at minimum: `DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`ENABLE_DEV_ENDPOINTS`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DEFAULT_TENANT_ID`.
Values MUST be placeholder strings (never real secrets).

#### Scenario: .env.example contains required keys

- GIVEN the repo root
- WHEN `.env.example` is read
- THEN all six keys listed above are present
- AND no real secret value appears in the file

---

### Requirement: Web Console — Send Flow

The `apps/web` console page MUST implement the following send flow when the user
clicks "Enviar mensaje":

1. Call `POST /dev/webhook-sign` with the current phone, profile name, and draft text
   to obtain `{ payload, signature }`.
2. Call `POST /webhooks/whatsapp` (the real webhook) with the returned `payload` as
   body and the returned `signature` as the `X-Hub-Signature-256` header.
3. After the webhook call completes (always 200), poll `GET /whatsapp-messages` to
   determine whether the message was persisted. The right panel (persisted messages)
   is the source of truth — NOT the HTTP status of the webhook call.
4. The send button MUST cycle through states: idle → sending → sent → idle.
5. A unique `wamid` is generated server-side by the signing proxy per send; the UI
   MUST NOT attempt to deduplicate sends.

#### Scenario: successful Peru send appears in the right panel

- GIVEN the backend is reachable, seed is applied, and a valid Peru phone (+51...) is entered
- WHEN the user types a message and clicks "Enviar mensaje"
- THEN a persisted card appears in the "Recibido por el Hub" panel after polling
- AND the card shows the contact name, phone, message text, and "Persistido" badge

#### Scenario: webhook always returns 200 — right panel is authoritative

- GIVEN any inbound message send (valid or invalid phone)
- WHEN the webhook is called
- THEN the webhook response is always `200`
- AND the UI does NOT interpret the 200 as confirmation of persistence; it MUST poll `GET /whatsapp-messages`

#### Scenario: non-Peru phone shows advisory warning; no card appears

- GIVEN the user enters a phone not matching `^\+519\d{8}$`
- WHEN the advisory warning is shown below the phone field
- THEN the warning is advisory only (send is not blocked)
- AND after send + poll, no new card appears in the right panel (backend rejected normalization)
- AND the "not persisted" banner is shown in the right panel

---

### Requirement: Web Console — UI States

The console MUST reproduce all states defined in the design reference.

| State | Panel | Trigger |
|-------|-------|---------|
| empty (left) | Simulador | No messages sent this session |
| sending | Simulador compose button | Between signing proxy call and webhook response |
| sent | Simulador compose button | After webhook responds (transient, ~1.5s) |
| loading-skeleton | Recibido panel | While GET /whatsapp-messages is in flight |
| persisted | Recibido panel | Row confirmed in DB |
| not-persisted warn | Recibido panel | Poll returned no new row for last sent wamid |
| empty (right) | Recibido panel | No messages for this tenant |
| offline | Header + disabled composer | Backend unreachable (network error on any call) |

#### Scenario: skeleton shown while polling

- GIVEN the user has just sent a message
- WHEN the GET /whatsapp-messages request is in flight
- THEN the right panel shows shimmer skeleton cards (not empty state and not a persisted card)

#### Scenario: offline state disables sending

- GIVEN the backend is unreachable
- WHEN the UI detects a network error
- THEN the offline banner is shown in the header
- AND the compose input is disabled
- AND the send button is disabled / non-interactive

---

### Requirement: Web Console — Theme Toggle

The console MUST support two visual themes: `light` (default) and `kanagawa` (dark).
Toggling the theme button in the header MUST switch between them. The active theme
MUST be expressed via a `data-theme` attribute on the root container, not by toggling
CSS class names. Both themes MUST match the design reference's CSS variable sets.

#### Scenario: kanagawa theme activates dark palette

- GIVEN the console is displayed in light theme
- WHEN the user clicks the theme toggle button
- THEN `data-theme="kanagawa"` is set on the root container
- AND the background, text, and accent colors switch to the kanagawa palette

#### Scenario: returning to light theme restores default

- GIVEN `data-theme="kanagawa"` is active
- WHEN the user clicks the theme toggle button again
- THEN `data-theme` is removed or set to `"light"`
- AND the light palette is restored

---

### Requirement: Web Console — Auto-Poll Toggle

The right panel MUST include a toggle button labeled "Auto" that enables or
disables automatic polling of `GET /whatsapp-messages` on a fixed interval
(5 seconds). A manual refresh button MUST always be available regardless of
auto-poll state.

#### Scenario: auto-poll refreshes the right panel periodically

- GIVEN auto-poll is enabled
- WHEN 5 seconds elapse
- THEN the right panel fetches `GET /whatsapp-messages` and re-renders

#### Scenario: manual refresh works when auto-poll is off

- GIVEN auto-poll is disabled
- WHEN the user clicks the refresh button
- THEN `GET /whatsapp-messages` is called once and the panel re-renders

---

## Out of Scope (Non-Requirements for This Slice)

- AI, outbound messages, auto-replies, broadcasts, templates, or opt-in flows.
- Production auth (JWT); this tool MUST NOT be deployed to production.
- SSE / WebSocket real-time updates (polling only).
- next-intl / i18n framework (inline Spanish strings).
- Automated React component tests for `apps/web` (no web test runner this slice).
- Any modification to `POST /webhooks/whatsapp`, `contacts`, or `contacts-tags-intent`.
- Non-Peru phone support (backend rejects them; UI is advisory only).
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
