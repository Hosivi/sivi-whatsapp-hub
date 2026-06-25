# Spec — dev-console (delta)

> Change: whatsapp-send-ui
> Domain: dev-console (MODIFIED capability — outbound send extension)
> Artifact store: hybrid
> Marker: ADDED requirements against the canonical spec at `openspec/specs/dev-console/spec.md`
> Last Updated: 2026-06-25

---

## Purpose

This is a **delta spec**. It extends the existing `dev-console` capability with
outbound send functionality. All requirements defined in the canonical spec
(`openspec/specs/dev-console/spec.md`) remain in force unchanged. This document
adds ONLY the new requirements introduced by the `whatsapp-send-ui` change.

The delta adds: an outbound composer in `HubPanel`, `sendOutbound()` API client,
`direction`-aware `MessageCard` badge, typed error surfacing, post-send polling
trigger, and dev fake Meta client gating behind `ENABLE_DEV_ENDPOINTS`.

Specs describe WHAT must be true — not HOW it is implemented.

---

## Added Requirements

### Requirement [ADDED]: GET /whatsapp-messages — direction Field in DTO

The response DTO for `GET /whatsapp-messages` MUST include a `direction` field
per message row with value `'inbound'` or `'outbound'` (matching the
`whatsapp_messages.direction` DB column, default `'inbound'`).
The field MUST be returned for ALL messages regardless of direction.
No existing field may be removed or renamed — this is an additive change.
The ordering and RLS behavior defined in the canonical spec are unchanged.

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

### Requirement [ADDED]: Dev Fake Meta Client Gating

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

### Requirement [ADDED]: Outbound Composer — HubPanel Reply Bar

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

### Requirement [ADDED]: Outbound Composer — Send Button States

The send button in the reply bar MUST cycle through states in this order on each
send attempt: `idle` → `sending` → `sent` → `idle`.

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

### Requirement [ADDED]: Outbound Composer — sendOutbound API Client

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

### Requirement [ADDED]: Outbound Composer — Recipient Advisory

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

### Requirement [ADDED]: Outbound Composer — Typed Error Surfacing

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

### Requirement [ADDED]: Outbound Composer — Post-Send Poll

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

### Requirement [ADDED]: Direction-Aware MessageCard Badge

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

## Updated Out of Scope (Non-Requirements for This Slice)

The existing out-of-scope list from the canonical spec remains in force. In addition:

- Optimistic outbound bubble insertion (card appears only after poll).
- Pre-filling `to` from inbound contact phone (starts blank, always).
- Tab/mode switcher or full chat-bubble refactor of `MessageCard`.
- Automated React component tests for `apps/web` (no web test runner, consistent with inbound slice).
- New migration or schema change (the `direction` DB column already exists).
- Changes to `POST /webhooks/whatsapp`, the whatsapp-send service/route, contacts, or contacts-tags-intent.
- Production deployment (this console is dev-only, guarded by `ENABLE_DEV_ENDPOINTS`).
- Auto-clear timer on the inline error message (cleared only by next send attempt).
