# Tasks — whatsapp-send-ui

> Change: whatsapp-send-ui
> Artifact store: hybrid
> Last Updated: 2026-06-25
> Dependency: spec at `openspec/changes/whatsapp-send-ui/specs/dev-console/spec.md`
>             design at `openspec/changes/whatsapp-send-ui/design.md`

---

## Task Groups

Tasks are ordered so each group is independently committable (work-unit-commits).
Groups 1 and 2 are independent and can run in parallel.
Group 3 depends on Group 1 (needs `direction` in web `MessageDTO` and `sendOutbound` in `api.ts`).

---

## Group 1 — Backend: direction DTO + dev gating (test-first)

**Sequential within group.** Two independent edits to two files; commit as two separate work units.

### 1.1 [TEST] Write failing test for `direction` in `listMessages` output

- [x] Create `apps/backend/src/whatsapp-messages/whatsapp-messages.repository.test.ts`
- [x] Import `listMessages` and build a minimal stub `TenantRunner` that returns a fake row with `direction: 'outbound'` (pure unit, no DB, no Testcontainers)
- [x] Assert: the returned `MessageDTO` contains `direction: 'outbound'`
- [x] Assert: the returned `MessageDTO` contains `direction: 'inbound'` for a fake row with `direction: 'inbound'`
- [x] Run `pnpm test` — test MUST fail (red) because `direction` is not in the select yet
- **Satisfies**: Requirement [ADDED] `GET /whatsapp-messages — direction Field in DTO`

### 1.2 [IMPL] Add `direction` to `whatsapp-messages.repository.ts`

- [x] Add `direction: string` field to the `MessageDTO` type (`readonly direction: string`)
- [x] Add `direction: whatsappMessagesTable.direction` to the Drizzle `.select({...})` call in `listMessages`
- [x] Add `direction: row.direction` to the row map in the `rows.map()` callback
- [x] No other field removed or renamed — additive change only
- [x] Run `pnpm test` — test from 1.1 MUST now pass (green)
- [x] Commit: `feat(whatsapp-messages): expose direction field in listMessages DTO`
- **Satisfies**: Requirement [ADDED] `GET /whatsapp-messages — direction Field in DTO`

### 1.3 [IMPL] Gate fake Meta client behind `ENABLE_DEV_ENDPOINTS` in `main.ts`

- [x] Add import for `createFakeMetaClient` from `'./meta/meta-client.js'` in `main.ts`
- [x] Replace the unconditional `createMetaClient(env.WHATSAPP_META_API_VERSION)` call with:
  ```ts
  const meta = env.ENABLE_DEV_ENDPOINTS
    ? createFakeMetaClient()
    : createMetaClient(env.WHATSAPP_META_API_VERSION);
  ```
- [x] Confirm `ENABLE_DEV_ENDPOINTS` is already in the env schema (`loadEnv`); add it if missing (boolean, default `false`)
- [x] Real client path and signature unchanged; no other lines in `main.ts` change
- [x] Note: this task has no automated test (gating logic is integration-level; fake client correctness is covered by meta-client.ts existing tests). Mark for manual verification in Group 3.
- [x] Commit: `feat(main): gate createFakeMetaClient behind ENABLE_DEV_ENDPOINTS`
- **Satisfies**: Requirement [ADDED] `Dev Fake Meta Client Gating`

---

## Group 2 — Web API client: `MessageDTO` + `sendOutbound` (no automated tests)

**Sequential within group.** Both changes are in `apps/web/src/lib/api.ts`; commit as one work unit.

### 2.1 [IMPL] Add `direction` to web `MessageDTO` and add `sendOutbound` + `SendOutboundError`

- [x] In `apps/web/src/lib/api.ts`:
  - Add `direction: string` to the `MessageDTO` interface (after `receivedAt`)
  - Add the `SendOutboundResult` interface: `{ wamid: string; status: string }`
  - Add the `SendOutboundError` class extending `Error` with a public `code: string` field
  - Add the `sendOutbound(tenantId, to, text)` async function:
    - Calls `POST ${apiUrl}/whatsapp-send`
    - Header `X-Tenant-Id: <tenantId>`
    - JSON body `{ to, text }`
    - On 200: return parsed `{ wamid, status }` as `SendOutboundResult`
    - On non-2xx: `throw new SendOutboundError(body.error ?? 'META_API_ERROR')`
    - On network/parse failure: `throw new SendOutboundError('NETWORK_ERROR')`
  - No existing export removed or renamed
- [x] Commit: `feat(web/api): add sendOutbound, SendOutboundError, direction to MessageDTO`
- **Satisfies**: Requirement [ADDED] `Outbound Composer — sendOutbound API Client`

---

## Group 3 — Web UI: page state, HubPanel reply bar, MessageCard badge

**Sequential within group; depends on Group 2 (needs updated `MessageDTO` and `sendOutbound`).**
The three UI tasks each produce an independently reviewable commit.

### 3.1 [IMPL] Add outbound state + `handleOutboundSend()` to `page.tsx`

- [x] In `apps/web/src/app/page.tsx`:
  - Add import for `sendOutbound` and `SendOutboundError` from `@/lib/api`
  - Add `OutboundSendStatus` type: `'idle' | 'sending' | 'sent'`
  - Add state: `outboundTo` (string, `''`), `outboundText` (string, `''`), `outboundSendStatus` (OutboundSendStatus, `'idle'`), `outboundError` (string | null, `null`)
  - Add the error-code → Spanish message map (const, outside the component or inside — consistent with existing style):
    ```
    NO_ACTIVE_ACCOUNT  → "No hay una cuenta de WhatsApp activa configurada."
    OUTBOUND_NOT_CONFIGURED → "La cuenta no tiene token configurado para envíos."
    MULTIPLE_ACTIVE_ACCOUNTS → "Hay más de una cuenta activa. Contactá al soporte."
    INVALID_RECIPIENT  → "El número no es válido para recibir mensajes de WhatsApp."
    WINDOW_CLOSED      → "La ventana de 24 h expiró. Solo podés responder dentro de la ventana activa."
    VALIDATION_ERROR   → "El número o el texto no son válidos. Revisá los campos."
    META_API_ERROR     → "Error al comunicarse con Meta. Intentá de nuevo."
    NETWORK_ERROR      → "No se pudo conectar con el servidor. Verificá tu conexión."
    default            → "Ocurrió un error inesperado. Intentá de nuevo."
    ```
  - Add `handleOutboundSend()` async function:
    1. Set `outboundSendStatus = 'sending'`, clear `outboundError`
    2. Call `sendOutbound(defaultTenantId, outboundTo, outboundText)`
    3. On success: set `outboundSendStatus = 'sent'`; after 1500 ms → `'idle'`; call `poll()` immediately
    4. On `SendOutboundError`: set `outboundError = map[e.code] ?? default`; set `outboundSendStatus = 'idle'`
    5. On success: clear `outboundError` (set to `null`)
  - Thread the new props into `<HubPanel>`:
    `outboundTo`, `outboundText`, `outboundSendStatus`, `outboundError`, `onOutboundToChange`, `onOutboundTextChange`, `onOutboundSend`
  - Existing `<HubPanel>` props (`messages`, `loading`, `notPersisted`, `autoOn`, `onAutoToggle`, `onRefresh`) unchanged
- [x] Commit: `feat(web/page): add outbound send state and handleOutboundSend`
- **Satisfies**: Requirements [ADDED] `Outbound Composer — Send Button States`, `Post-Send Poll`, `Typed Error Surfacing`

### 3.2 [IMPL] Add outbound reply bar to `HubPanel.tsx`

- [x] In `apps/web/src/components/HubPanel.tsx`:
  - Extend `HubPanelProps` with the new props received from `page.tsx`:
    `outboundTo: string`, `outboundText: string`, `outboundSendStatus: 'idle' | 'sending' | 'sent'`, `outboundError: string | null`, `onOutboundToChange: (v: string) => void`, `onOutboundTextChange: (v: string) => void`, `onOutboundSend: () => void`
  - Add a footer section below the messages body, separated by a visible `<hr>`-style divider:
    - Section label "Enviar mensaje" (or similar, visually distinct from the inbound section)
    - `<input>` for `to` (placeholder "Destinatario (+519...)", value = `outboundTo`, onChange = `onOutboundToChange`, starts blank)
    - Advisory: when `!isPeru(outboundTo) && outboundTo.length > 0` → render a warning text below the `to` input (import `isPeru` from `@/lib/phone`)
    - `<input>` for `text` (placeholder "Texto del mensaje", value = `outboundText`, onChange = `onOutboundTextChange`)
    - Send button: disabled when `outboundSendStatus !== 'idle'`; label cycles `"Enviar"` / `"Enviando…"` / `"Enviado ✓"` per status
    - Inline error: render `outboundError` below the send button when it is not `null`; NOT visible when `null`
  - Header, body (messages list), and existing toggle/refresh controls MUST NOT change
- [x] Commit: `feat(web/hub-panel): add outbound reply bar with advisory and inline error`
- **Satisfies**: Requirements [ADDED] `Outbound Composer — Reply Bar`, `Send Button States`, `Recipient Advisory`, `Typed Error Surfacing`

### 3.3 [IMPL] Add direction badge to `MessageCard.tsx`

- [x] In `apps/web/src/components/MessageCard.tsx`:
  - The `message` prop is typed as `MessageDTO` (imported from `@/lib/api`), which now includes `direction: string` from Task 2.1
  - In the card header row (next to the existing "Persistido" badge), render a direction badge:
    - `direction === 'outbound'` → badge text "Enviado", use a visually distinct color (e.g., `var(--blue)` or a purple/accent CSS var consistent with the existing design system — pick one that doesn't clash with the green "Persistido" badge)
    - `direction === 'inbound'` (or any other value) → badge text "Recibido", use a neutral chip style consistent with existing `var(--chip-bg)` / `var(--chip-text)` / `var(--chip-border)`
  - Card layout (avatar, name, phone, text body, footer row with type/wamid/time) MUST NOT change
- [x] Commit: `feat(web/message-card): add direction badge (Enviado/Recibido)`
- **Satisfies**: Requirement [ADDED] `Direction-Aware MessageCard Badge`

---

## Group 4 — Manual Verification

**Depends on all of Groups 1–3 being applied.**
Not a code task; defines the acceptance checklist before PR creation.

### 4.1 [VERIFY] End-to-end manual verification via `pnpm dev:local`

Run `pnpm --filter @sivihub/whatsapp-hub-web dev:local` (NOT `dev` — Node 25 SSR crash) with `ENABLE_DEV_ENDPOINTS=true`, Postgres migrated, `seed-dev` applied.

- [x] **Direction badge on inbound cards**: seed-injected inbound messages show "Recibido" badge
- [x] **Reply bar renders blank**: `to` input is empty on page load; `text` input is empty
- [x] **Peru advisory**: enter `+1555000000` → advisory shown below `to`; send button remains enabled
- [x] **No advisory for Peru number**: enter `+51987654321` → no advisory shown
- [x] **Send success flow**: fill `to` (Peru) + text → click send → button shows "Enviando…" → then "Enviado ✓" for ~1.5 s → returns to "Enviar" → new outbound card with "Enviado" badge appears in HubPanel
- [x] **INVALID_RECIPIENT**: fill `to` (non-Peru) + text → send → button returns to "Enviar" immediately (no "Enviado ✓") → inline error "El número no es válido para recibir mensajes de WhatsApp."
- [x] **WINDOW_CLOSED** (simulate if possible via queueError or unit test of the error map): inline error "La ventana de 24 h expiró. Solo podés responder dentro de la ventana activa."
- [x] **Error overwritten on retry**: send with error → send again → previous error replaced
- [x] **Error clears on success**: send with error → fix `to` to Peru → send succeeds → no error shown
- [x] **No graph.facebook.com call**: confirm dev sends use fake client (no real Meta token needed)
- [x] **`pnpm test` green** (backend): `direction` test in 1.1 passes — 279 tests passed (4 new direction tests GREEN); 2 file-level failures are pre-existing (@sivihub/contracts not built)

### 4.2 [VERIFY] Confirm PR is within 400-line budget

- [x] Run `git diff --stat main...HEAD` in the worktree — actual: ~260 changed lines (within 400-line budget)
- [x] Single PR #5 to main — confirmed within budget, no split needed

---

## Dependency Map

```
1.1 (test: direction) → 1.2 (impl: direction) ─┐
                                                  ├─► 4.1 (manual verify)
1.3 (impl: dev gating)                          ─┤
                                                  │
2.1 (api client) ─► 3.1 (page state) ─┬─► 3.2 ─┤
                                        └─► 3.3 ─┘
```

Groups 1 and 2 are parallel. Group 3 is sequential after Group 2.

---

## Review Workload Forecast

| Category | Estimated changed lines |
|---|---|
| `whatsapp-messages.repository.ts` (DTO + select + map) | ~12 |
| `whatsapp-messages.repository.test.ts` (new file, unit test) | ~40 |
| `main.ts` (gating + import) | ~8 |
| `apps/web/src/lib/api.ts` (MessageDTO + sendOutbound + types) | ~35 |
| `apps/web/src/app/page.tsx` (state + handler + props) | ~60 |
| `apps/web/src/components/HubPanel.tsx` (props + footer bar) | ~80 |
| `apps/web/src/components/MessageCard.tsx` (direction badge) | ~25 |
| **Total estimated** | **~260 lines** |

**400-line budget risk**: Low — estimated ~260 changed lines, well within the 400-line threshold.
**Chained PRs recommended**: No — a single focused PR is the correct delivery unit.
**Decision needed before apply**: No — proceed as a single PR.
**PR strategy**: Single PR targeting `main` from `feat/whatsapp-send-ui`. Work-unit commits (5 commits as described above) keep the history clean and each commit independently reviewable.
