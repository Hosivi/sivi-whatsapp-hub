# Spec — dev-console

> **Domain**: dev-console (dev-only inbound + outbound simulation console)
> **Scope**: whatsapp-inbound-test-ui + whatsapp-send-ui — exercise the full inbound reception and outbound send paths end-to-end without a real Meta callback
> **Last Updated**: 2026-06-25 (whatsapp-send-ui merged: outbound send panel)

---

## Purpose

Define the observable behavior for the dev-only inbound + outbound simulation console.
This includes a signing proxy, message read-back endpoint, dev seed, env/CORS gating,
and a Next.js 15 web page that lets a developer exercise the full WhatsApp inbound
reception path and outbound send path end-to-end without a real Meta callback or a
real Meta token.
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

The response DTO MUST include a `direction` field per message row with value
`'inbound'` or `'outbound'` (matching the `whatsapp_messages.direction` DB column,
default `'inbound'`). The field MUST be returned for ALL messages regardless of
direction. No existing response field may be removed or renamed.

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

#### Scenario: direction field is present on inbound message

- GIVEN a message was persisted via the inbound webhook (`direction = 'inbound'`)
- WHEN `GET /whatsapp-messages` is called with a valid `X-Tenant-Id`
- THEN each message object in the response body contains a `direction` field
- AND the value is `'inbound'`

#### Scenario: direction field is present on outbound message

- GIVEN a message was persisted via `POST /whatsapp-send` (`direction = 'outbound'`)
- WHEN `GET /whatsapp-messages` is called with the same tenant's `X-Tenant-Id`
- THEN the outbound message object contains `direction: 'outbound'`

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

### Requirement: Dev Fake Meta Client Gating

When `ENABLE_DEV_ENDPOINTS=true`, the backend MUST compose the outbound send
pipeline using `createFakeMetaClient()` instead of the real `createMetaClient(...)`.
The fake client MUST NOT make any HTTP request to `graph.facebook.com`.
When `ENABLE_DEV_ENDPOINTS` is absent or `"false"`, the real Meta client MUST be
used and the fake client MUST NOT be reachable.
The gate MUST be evaluated at server startup (in `main.ts`), not per-request.
The real client's behavior, configuration, and code are unchanged.

#### Scenario: fake Meta client used when dev flag is on

- GIVEN `ENABLE_DEV_ENDPOINTS=true`
- WHEN `POST /whatsapp-send` is called with a valid body and active dev seed account
- THEN the outbound pipeline invokes `createFakeMetaClient()` (no call to `graph.facebook.com`)
- AND the response is `200` with a synthetic `wamid`

#### Scenario: real Meta client used when dev flag is off

- GIVEN `ENABLE_DEV_ENDPOINTS` is not set (or `"false"`)
- WHEN the backend starts
- THEN `createFakeMetaClient()` is NOT composed into the send pipeline
- AND outbound sends use the real `createMetaClient(...)` instance

#### Scenario: fake client does not call graph.facebook.com

- GIVEN `ENABLE_DEV_ENDPOINTS=true`
- AND `POST /whatsapp-send` is called
- THEN no outbound HTTP request to `https://graph.facebook.com` is made
- AND the send succeeds without a real Meta token

---

### Requirement: Web Console — Outbound Reply Bar

`HubPanel` MUST render a reply bar in its footer section, separated from the
messages list by a visible divider. The reply bar MUST contain:
- A `to` field — text input accepting an E.164 phone number; MUST start BLANK.
- A `text` field — text input for the message body.
- A send button.

The reply bar MUST be visually distinct from the inbound simulator composer.
No existing `HubPanel` layout or content above the divider may be altered.

#### Scenario: reply bar renders with blank to field

- GIVEN the console page is loaded
- WHEN `HubPanel` is rendered
- THEN the footer reply bar is visible
- AND the `to` input is empty (no pre-filled phone number)
- AND the `text` input is empty

---

### Requirement: Web Console — Outbound Send Button States

The send button in the outbound reply bar MUST cycle through states in this order
on each send attempt: `idle` → `sending` → `sent` → `idle`.

- `idle`: button is enabled and ready; label indicates send action.
- `sending`: button is disabled; triggered from the moment `sendOutbound()` is
  called until the response (success or error) is received.
- `sent`: button is disabled; shown transiently (~1.5 s) after a successful send
  before returning to `idle`.

On error, the button MUST return directly from `sending` to `idle` (no `sent`
interstitial). The `to` and `text` inputs MUST remain editable at all times
(never locked during `sending`).

#### Scenario: button cycles idle → sending → sent → idle on success

- GIVEN the console page is loaded and backend is reachable
- WHEN the user fills in `to` and `text` and clicks send
- THEN the button transitions to `sending` immediately
- AND after a successful response, the button transitions to `sent`
- AND after ~1.5 s the button returns to `idle`

#### Scenario: button returns to idle on error without sent state

- GIVEN the backend returns any error (e.g. `WINDOW_CLOSED`)
- WHEN the send completes
- THEN the button transitions directly from `sending` to `idle`
- AND the `sent` state is never shown

---

### Requirement: Web Console — sendOutbound API Client

`apps/web/src/lib/api.ts` MUST export a `sendOutbound(tenantId, to, text)` function
that calls `POST /whatsapp-send` with:
- Header `X-Tenant-Id: <tenantId>`
- JSON body `{ to, text }`

The function MUST return a typed result distinguishing success from typed error
codes. The `MessageDTO` web type MUST be updated to include `direction: string`.
No existing exported function or type in `api.ts` may be removed or renamed.

#### Scenario: sendOutbound sends correct headers and body

- GIVEN a valid `tenantId`, `to`, and `text`
- WHEN `sendOutbound(tenantId, to, text)` is called
- THEN a `POST` request is made to `/whatsapp-send`
- AND the request includes `X-Tenant-Id: <tenantId>` header
- AND the request body is `{ "to": "<to>", "text": "<text>" }`

---

### Requirement: Web Console — Outbound Recipient Advisory

When the value in the `to` field does NOT match the Peru pattern (`^\+519\d{8}$`),
the console MUST display an advisory warning below the `to` input.
The advisory is informational ONLY — the send button MUST NOT be disabled by the
client-side advisory. The backend will return `422 INVALID_RECIPIENT` for such
numbers; the error surfaces via the typed error surfacing requirement below.

#### Scenario: advisory shown for non-Peru number

- GIVEN the user enters a phone not matching `^\+519\d{8}$` (e.g. `+1555000000`)
- WHEN the `to` input value changes
- THEN an advisory warning is rendered below the `to` field
- AND the send button remains enabled (not blocked by the advisory)

#### Scenario: no advisory for valid Peru number

- GIVEN the user enters a phone matching `^\+519\d{8}$` (e.g. `+51987654321`)
- WHEN the `to` input value changes
- THEN no advisory warning is shown

---

### Requirement: Web Console — Outbound Typed Error Surfacing

When `sendOutbound()` returns an error, the console MUST display a Spanish error
message below the send button. The message MUST be determined by the error code
returned by the backend according to this table:

| Error code | Spanish message |
|---|---|
| `NO_ACTIVE_ACCOUNT` | "No hay una cuenta de WhatsApp activa configurada." |
| `OUTBOUND_NOT_CONFIGURED` | "La cuenta no tiene token configurado para envíos." |
| `MULTIPLE_ACTIVE_ACCOUNTS` | "Hay más de una cuenta activa. Contactá al soporte." |
| `INVALID_RECIPIENT` | "El número no es válido para recibir mensajes de WhatsApp." |
| `WINDOW_CLOSED` | "La ventana de 24 h expiró. Solo podés responder dentro de la ventana activa." |
| `VALIDATION_ERROR` | "El número o el texto no son válidos. Revisá los campos." |
| `META_API_ERROR` | "Error al comunicarse con Meta. Intentá de nuevo." |
| `NETWORK_ERROR` | "No se pudo conectar con el servidor. Verificá tu conexión." |
| any other / unknown | "Ocurrió un error inesperado. Intentá de nuevo." |

The error message MUST be overwritten (replaced) on the next send attempt —
no auto-clear timer. On a successful send the error message MUST be cleared.
The error display area MUST NOT be visible when there is no active error.

#### Scenario: NO_ACTIVE_ACCOUNT maps to correct Spanish message

- GIVEN the backend returns `NO_ACTIVE_ACCOUNT`
- WHEN the send completes
- THEN the Spanish message "No hay una cuenta de WhatsApp activa configurada." is shown below the send button

#### Scenario: WINDOW_CLOSED maps to correct Spanish message

- GIVEN the backend returns `WINDOW_CLOSED`
- WHEN the send completes
- THEN the Spanish message "La ventana de 24 h expiró. Solo podés responder dentro de la ventana activa." is shown below the send button

#### Scenario: unknown error code falls back to generic Spanish message

- GIVEN the backend returns an unrecognized error code
- WHEN the send completes
- THEN the generic Spanish message "Ocurrió un error inesperado. Intentá de nuevo." is shown below the send button

#### Scenario: error message is overwritten on next send attempt

- GIVEN a previous send produced a `WINDOW_CLOSED` error message
- WHEN the user sends again (any outcome)
- THEN the previous error message is replaced by the new send's result

#### Scenario: error message clears on successful send

- GIVEN a previous send produced an error message
- WHEN the next send succeeds
- THEN no error message is shown below the send button

#### Scenario: NETWORK_ERROR maps to correct Spanish message

- GIVEN the request to `POST /whatsapp-send` fails at the network level (no HTTP response)
- WHEN the send completes
- THEN the Spanish message "No se pudo conectar con el servidor. Verificá tu conexión." is shown below the send button

---

### Requirement: Web Console — Outbound Post-Send Poll

After a successful `sendOutbound()` response, the console MUST immediately trigger
the existing `GET /whatsapp-messages` poll so the persisted outbound row appears
in `HubPanel`. The poll MUST be the same function used by auto-poll and manual
refresh — no separate fetch path. No optimistic message insertion is permitted;
the outbound card appears ONLY after the poll returns.

#### Scenario: outbound card appears in HubPanel after successful send + poll

- GIVEN `ENABLE_DEV_ENDPOINTS=true`, the seed is applied, and a valid Peru `to` is entered
- WHEN the user sends an outbound message and the send succeeds
- THEN `GET /whatsapp-messages` is called immediately after the success response
- AND the outbound message row appears as a card in `HubPanel` after the poll completes

#### Scenario: poll not triggered on send error

- GIVEN the backend returns any error code
- WHEN the send completes
- THEN `GET /whatsapp-messages` is NOT triggered as part of the error handling path

---

### Requirement: Web Console — Direction-Aware MessageCard Badge

`MessageCard` MUST render a directional badge for every message using the
`direction` field from the `MessageDTO`. The badge text and appearance MUST be:

| `direction` | Badge text |
|---|---|
| `'inbound'` | "Recibido" |
| `'outbound'` | "Enviado" |

The badge MUST be visible on all cards. The existing `MessageCard` layout
(fields, spacing, other badges) MUST NOT change — this is an additive badge.

#### Scenario: inbound MessageCard shows "Recibido" badge

- GIVEN a message with `direction: 'inbound'` is present in the poll response
- WHEN `MessageCard` renders that message
- THEN the badge "Recibido" is visible on the card

#### Scenario: outbound MessageCard shows "Enviado" badge

- GIVEN a message with `direction: 'outbound'` is present in the poll response
- WHEN `MessageCard` renders that message
- THEN the badge "Enviado" is visible on the card

#### Scenario: both badges appear in the same HubPanel list

- GIVEN the tenant has one inbound and one outbound message
- WHEN `GET /whatsapp-messages` is polled and the panel re-renders
- THEN one card shows "Recibido" and one card shows "Enviado"

---

## Out of Scope (Non-Requirements for This Slice)

- AI, auto-replies, broadcasts, templates, or opt-in flows.
- Production auth (JWT); this tool MUST NOT be deployed to production.
- SSE / WebSocket real-time updates (polling only).
- next-intl / i18n framework (inline Spanish strings).
- Automated React component tests for `apps/web` (no web test runner).
- Any modification to `POST /webhooks/whatsapp`, the whatsapp-send service/route, `contacts`, or `contacts-tags-intent`.
- Non-Peru phone support (backend rejects them; UI is advisory only).
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
- Optimistic outbound bubble insertion (card appears only after poll).
- Pre-filling `to` from inbound contact phone (starts blank, always).
- Tab/mode switcher or full chat-bubble refactor of `MessageCard`.
- New migration or schema change (the `direction` DB column already exists).
- Auto-clear timer on the inline outbound error message (cleared only by next send attempt).
