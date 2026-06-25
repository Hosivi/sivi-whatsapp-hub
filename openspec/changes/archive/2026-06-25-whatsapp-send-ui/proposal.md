# Proposal: WhatsApp Outbound Send UI (dev console)

## Intent

The dev console proves the **inbound** path end-to-end, but the outbound endpoint (`POST /whatsapp-send`) is LIVE with **no human-facing way to exercise it** — only the test suite calls it. A dev cannot type a reply "as the business", send it, and watch the outbound row appear. Corte 2: add an **outbound send panel** to the existing console so a dev sends via the real send pipeline and sees the persisted outbound card via polling. Frontend-led, mock-first, two small backend touches. Success = dev types `to` + text, sends, and a card badged "Enviado" appears in HubPanel after the poll.

## Scope

### In Scope
- Reply bar in `HubPanel` footer — `to` + text + send button (states), divider above the messages list.
- `sendOutbound(tenantId, to, text)` in `lib/api.ts` (POST `/whatsapp-send` + `X-Tenant-Id`) + add `direction: string` to web `MessageDTO`.
- Backend read DTO — add `direction` to `whatsapp-messages.repository.ts` (Drizzle select + type + row map). DB column exists; select omits it.
- Dev fake Meta client gating — in `main.ts`, when `ENABLE_DEV_ENDPOINTS=true`, compose `createFakeMetaClient()` instead of real `createMetaClient(...)`; real client kept for non-dev.
- Direction-aware `MessageCard` badge — "Recibido"/"Enviado"; card layout unchanged.
- Recipient advisory — reuse `isPeru()` warning below `to` (non-Peru → backend 422 INVALID_RECIPIENT).
- Inline error surfacing — typed codes → Spanish messages below send button (NO_ACTIVE_ACCOUNT, OUTBOUND_NOT_CONFIGURED, WINDOW_CLOSED, INVALID_RECIPIENT, META_API_ERROR, NETWORK_ERROR, generic).
- Trigger existing `poll()` after success (no optimistic add).

### Out of Scope
- Optimistic outbound bubbles; pre-fill `to` from inbound phone (follow-up).
- Tab/mode switcher; full chat-bubble refactor of MessageCard.
- Web test runner; new backend endpoint/migration; changes to webhook/contacts/whatsapp-send service+route.
- AI, templates, broadcasts, opt-in; production readiness (dev-only tool).

## Capabilities

### New Capabilities
None — extends existing `dev-console`; no new spec-level capability.

### Modified Capabilities
- `dev-console`: add outbound send flow (reply bar, sendOutbound client, direction-aware rendering, typed-error surfacing, dev fake Meta client gating) and expose `direction` on the messages read DTO.

## Approach

Frontend-led, mock-first. UI calls the EXISTING `POST /whatsapp-send` (reused unmodified) via new `sendOutbound()`; on success triggers existing immediate `poll()` so the persisted outbound row appears — messages panel stays single source of truth (same as inbound). Two backend touches for dev end-to-end: (1) read DTO must carry `direction` so UI can badge inbound vs outbound; (2) `main.ts` must compose `createFakeMetaClient()` under `ENABLE_DEV_ENDPOINTS=true`, because the dev seed has a placeholder token and the real client would hit graph.facebook.com and fail.

### Resolved Decisions (settled — not open)
1. UX: reply bar in HubPanel footer, divider above. Minimal change; no new grid column.
2. Direction rendering: badge only ("Recibido"/"Enviado"); keep card layout (DB panel, not chat).
3. `to` field: starts BLANK — explicit recipient, never auto-filled from inbound phone.
4. Error model: typed codes → inline Spanish message below send button, OVERWRITTEN on next attempt (no auto-clear timer).
5. State/polling: reuse existing `poll()` after success — no optimistic add.
6. Backend DTO `direction`: REQUIRED, additive, low-risk.
7. Dev Meta client: gate on `ENABLE_DEV_ENDPOINTS`; `createFakeMetaClient` already in `meta-client.ts`; real client unchanged for non-dev.
8. Header copy: minor tweak to reflect both directions — optional, low priority.
9. Testing: no web runner (consistent with inbound slice). Backend: optionally assert `direction` returned by repository + dev gating composes fake client; rest manual.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/web/src/components/HubPanel.tsx` | Modified | Reply bar (footer): to + text + send + Peru advisory + inline error |
| `apps/web/src/app/page.tsx` | Modified | Outbound send state + handler; poll on success |
| `apps/web/src/lib/api.ts` | Modified | sendOutbound(); add direction to MessageDTO |
| `apps/web/src/components/MessageCard.tsx` | Modified | Direction-aware badge |
| `apps/web/src/components/Header.tsx` | Modified | Optional title tweak (low priority) |
| `apps/backend/src/whatsapp-messages/whatsapp-messages.repository.ts` | Modified | Add direction to select + DTO + row map |
| `apps/backend/src/main.ts` | Modified | Gate fake Meta client behind ENABLE_DEV_ENDPOINTS |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Dev fake client leaks to prod | Low | Gated on explicit ENABLE_DEV_ENDPOINTS; default false; real client unchanged |
| direction DTO change ripples | Low | Additive field; consumers ignore it; web MessageDTO updated same PR |
| next dev crash on Node 25 | Med | Run via dev:local (documented); no SSR work added |
| Non-Peru recipient confusion | Med | Inline isPeru() advisory + backend 422 surfaced inline |
| No web tests for UI | Med | Consistent with inbound slice; manual verify; backend touches are testable surface |

## Delivery

Likely a single small PR, well within the 400-line budget — two narrow backend edits plus footer/composer additions to existing components (no new infra, no migration). delivery_strategy = ask-on-risk; no split anticipated.

## Rollback Plan

Additive and self-contained. Revert the PR: removes reply bar, sendOutbound, direction badge, repository direction field, dev fake-client gating. Webhook, contacts, whatsapp-send service/route, schema, migrations untouched — no DB/contract rollback.

## Dependencies

- Running Postgres with migrations applied + seed-dev executed.
- ENABLE_DEV_ENDPOINTS=true for dev fake Meta client + CORS.
- Console run via `pnpm dev:local` (NOT `dev`).

## Success Criteria

- [ ] Dev types to (Peru) + text, sends → outbound card badged "Enviado" appears after poll.
- [ ] Inbound cards badged "Recibido"; direction field present in GET /whatsapp-messages.
- [ ] Non-Peru to shows inline advisory; backend INVALID_RECIPIENT surfaces as Spanish message.
- [ ] Each typed outbound error code maps to a distinct inline Spanish message, overwritten on next attempt.
- [ ] With ENABLE_DEV_ENDPOINTS=true, sends use fake Meta client (no graph.facebook.com call); real client otherwise.
- [ ] Backend pnpm test green; to starts blank; no optimistic add (card appears via poll).

## Verified Facts (grounding)
- `whatsapp-messages.repository.ts` MessageDTO has NO `direction` (select lines ~59-66). CONFIRMED.
- `main.ts` line 29 always builds `createMetaClient(env.WHATSAPP_META_API_VERSION)` — no dev gating. CONFIRMED.
- `createFakeMetaClient` exists in `meta-client.ts` (~line 149). CONFIRMED.
- `whatsapp_messages` table HAS `direction` column ('inbound'|'outbound', default 'inbound', added migration 0003). CONFIRMED.
- Outbound error codes live in `whatsapp-send.service.ts` + `whatsapp-send.errors.ts`. CONFIRMED.
- Worktree IS on main@d643fcb with apps/web + whatsapp-send backend present (explore's BLOCKING-rebase risk is FALSE/disproven). CONFIRMED.
