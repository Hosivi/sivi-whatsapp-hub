# Design: WhatsApp Outbound Send UI (dev console)

## Technical Approach
Frontend-led, mock-first, additive. UI calls the EXISTING unmodified `POST /whatsapp-send` via new `sendOutbound()`; on success triggers existing `poll()` so the persisted outbound row appears via the same single-source path as inbound. Two narrow backend touches for dev end-to-end: read DTO carries `direction` (badge inbound vs outbound), and `main.ts` composes the fake Meta client under `ENABLE_DEV_ENDPOINTS=true` (dev seed token would otherwise hit graph.facebook.com). No new route/service/schema/migration.

## Architecture Decisions
| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Outbound state | New state + `handleOutboundSend()` in `page.tsx`, props to `HubPanel` | State in HubPanel/composer | page.tsx single state owner (mirrors `handleSend`); children presentational |
| Post-send refresh | Reuse existing `poll()` after 200 | Optimistic bubble | Panel stays DB truth; no reconciliation |
| Direction | Add `direction` to read DTO; `MessageCard` badge | Heuristic infer | Authoritative column exists (migration 0003); additive |
| Dev Meta client | Gate `createFakeMetaClient()` on `ENABLE_DEV_ENDPOINTS` in composition root | Flag in service; fake route | Composition-root swap; service/route untouched; real client unchanged for prod |
| Error model | Typed code -> inline Spanish string below send btn, overwritten next attempt | Toast; auto-clear timer | Deterministic, dev-friendly |
| Recipient check | Advisory `isPeru()` mirror only | Hard client block | Backend authoritative (422 INVALID_RECIPIENT) |

## Data Flow
HubPanel footer (to+text+Send) -> page.tsx handleOutboundSend (status='sending', clear error) -> lib/api.ts sendOutbound -> POST /whatsapp-send (X-Tenant-Id,{to,text}) -> backend (unmodified) service -> MetaClient (ENABLE_DEV_ENDPOINTS ? fake : real). ok {wamid,status} -> status='sent' -> poll() -> GET /whatsapp-messages -> HubPanel renders cards, MessageCard badges direction. err {error:CODE} -> outboundError=MAP[CODE], status='idle'.

## File Changes
| File | Action | Description |
|---|---|---|
| apps/web/src/app/page.tsx | Modify | Add outboundTo/outboundText/outboundSendStatus/outboundError + handleOutboundSend(); thread props to HubPanel; poll() on success |
| apps/web/src/components/HubPanel.tsx | Modify | Footer reply bar (to+text+send states+Peru advisory+inline error) via new props; header/body untouched |
| apps/web/src/components/MessageCard.tsx | Modify | Read message.direction; badge 'Enviado'/'Recibido'; layout unchanged |
| apps/web/src/lib/api.ts | Modify | Add direction:string to MessageDTO; add sendOutbound() (typed success or coded throw) |
| apps/backend/src/whatsapp-messages/whatsapp-messages.repository.ts | Modify | Add direction to .select() + MessageDTO type + row map (additive) |
| apps/backend/src/main.ts | Modify | Compose fake Meta client when ENABLE_DEV_ENDPOINTS===true |
| apps/web/src/components/Header.tsx | Modify (optional) | Minor title tweak; low priority |

## Interfaces / Contracts
lib/api.ts:
- MessageDTO gains `direction: string` ('inbound'|'outbound', drives badge).
- `class SendOutboundError extends Error { constructor(public code:string) }`.
- `sendOutbound(tenantId, to, text): Promise<{wamid:string; status:string}>` — POST /whatsapp-send + X-Tenant-Id + {to,text}; 200 -> {wamid,status}; non-2xx -> throw SendOutboundError(body.error ?? 'META_API_ERROR'); network/parse fail -> throw SendOutboundError('NETWORK_ERROR').

Error code -> Spanish map (in page.tsx):
- NO_ACTIVE_ACCOUNT: No hay una cuenta de WhatsApp activa para este tenant.
- OUTBOUND_NOT_CONFIGURED: La cuenta no tiene token de envio configurado.
- WINDOW_CLOSED: La ventana de 24 horas esta cerrada; no se puede enviar texto libre.
- INVALID_RECIPIENT: Numero invalido — usa formato E.164 de Peru (+519XXXXXXXX).
- META_API_ERROR: Meta rechazo el envio. Revisa la consola del backend.
- NETWORK_ERROR: No se pudo contactar al backend.
- default: Error inesperado al enviar el mensaje.
(MULTIPLE_ACTIVE_ACCOUNTS, INTERNAL_ERROR fall through to default.)

main.ts gating:
```ts
const meta = env.ENABLE_DEV_ENDPOINTS
  ? createFakeMetaClient() // deterministic { wamid:'wamid-fake-1', status:'accepted' } -> card appears on poll
  : createMetaClient(env.WHATSAPP_META_API_VERSION);
```
Safe: dev-only swap (ENABLE_DEV_ENDPOINTS default false); service/route unchanged; real client is prod default.

Backend repo change (additive): add `direction: whatsappMessagesTable.direction` to .select(), `readonly direction: string` to MessageDTO, `direction: row.direction` to row map. Column exists default 'inbound'.

## Testing Strategy
| Layer | What | Approach |
|---|---|---|
| Backend unit | listMessages returns direction per DTO | Vitest (existing pnpm test); repo DTO is the only net-new testable surface |
| Backend optional | Dev gating composes fake client | Light assertion; low priority |
| Web | Send flow/badge/error map | None — no web runner (consistent with inbound slice); manual via pnpm dev:local |

## Migration / Rollout
No migration — direction column exists (migration 0003). Run via `pnpm dev:local` (Node 25 SSR crash on plain dev). Needs ENABLE_DEV_ENDPOINTS=true, Postgres migrated, seed-dev executed.

## Open Questions
None blocking. Header copy tweak optional/low priority, droppable.
