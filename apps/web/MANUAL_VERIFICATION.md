# Manual Verification Checklist — WhatsApp Inbound Dev Console

> This checklist covers all 8 UI states, both themes, auto-poll, and edge cases.
> Run through it after every change to `apps/web` or the backend dev surfaces.
> No automated React tests exist for this slice — this checklist IS the verification.

---

## Prerequisites

1. **Install dependencies** (from repo root):
   ```
   pnpm install
   ```

2. **Run database migrations** (from repo root):
   ```
   pnpm --filter @sivihub/whatsapp-hub-backend migrate
   ```

3. **Seed dev data** — inserts the dev tenant + whatsapp_accounts row:
   ```
   pnpm --filter @sivihub/whatsapp-hub-backend seed:dev
   ```
   Expected output: `[seed-dev] done — dev whatsapp_accounts row seeded`

4. **Copy env files**:
   - Backend: copy `apps/backend/.env.example` → `apps/backend/.env` and fill in real values
   - Web: copy `apps/web/.env.local.example` → `apps/web/.env.local`
   - Verify `NEXT_PUBLIC_DEFAULT_TENANT_ID=00000000-0000-0000-0000-000000000001`

5. **Start backend** with dev endpoints enabled:
   ```
   ENABLE_DEV_ENDPOINTS=true pnpm --filter @sivihub/whatsapp-hub-backend dev
   ```
   Confirm: `Listening on port 3001`

6. **Start web console**:
   ```
   pnpm --filter @sivihub/whatsapp-hub-web dev
   ```
   Open `http://localhost:3000`

---

## State Checklist

### State 1 — Idle (initial)
- [ ] Page loads without errors
- [ ] Left panel shows "Sin mensajes en esta sesión" empty state
- [ ] Right panel shows "Todavía no llegó ningún mensaje" empty state
- [ ] Send button is disabled (grayed out, `cursor: not-allowed`)
- [ ] Header shows green dot ("Conectado") within 5 s (auto-poll fires)
- [ ] DevTools: Network tab shows `GET /whatsapp-messages` with `X-Tenant-Id` header

### State 2 — Sending (in-flight)
- [ ] Enter a valid Peru number: `+51987654321`
- [ ] Enter any profile name and message text
- [ ] Click "Enviar mensaje"
- [ ] Button immediately changes to spinning "Enviando…" state (green-send bg)
- [ ] Draft field is cleared optimistically
- [ ] A bubble appears in the chat zone (right-aligned, green bubble for Peru number)
- [ ] DevTools: `POST /dev/webhook-sign` fires first, then `POST /webhooks/whatsapp`

### State 3 — Sent (transient ~700 ms)
- [ ] After webhook call completes, button shows checkmark "Enviado" (green-sent bg)
- [ ] After ~700 ms, button returns to idle state

### State 4 — Loading skeleton (polling)
- [ ] During `GET /whatsapp-messages` in-flight, right panel shows 3 animated shimmer cards
- [ ] Shimmer animation is visible (not a static gray block)
- [ ] DevTools: confirm the GET fires after each send

### State 5 — Persisted (Peru phone)
- [ ] After polling completes, right panel shows a message card for the Peru number
- [ ] Card includes: avatar initials, display name (or phone), phone number, message text
- [ ] "Persistido" badge (green) is visible on the card
- [ ] Card has type chip (e.g., `text`) and wamid shown (truncated)
- [ ] `cardIn` animation plays on new card appearance

### State 6 — Not-persisted warning (non-Peru phone)
- [ ] Change phone to a non-Peru number: `+1234567890`
- [ ] Advisory warning appears below phone field: "Número no peruano…"
- [ ] Warning banner appears above composer: references `normalizePhoneE164`
- [ ] Send the message — bubble appears in amber/warn color (not green)
- [ ] After polling, NO new card appears in right panel
- [ ] Yellow warning banner appears in right panel: "El último envío no se persistió…"
- [ ] Warning banner auto-dismisses after ~4 s

### State 7 — Empty right panel
- [ ] Verify with a fresh tenant (or after clearing the DB) that the right panel shows the empty state illustration and message: "Todavía no llegó ningún mensaje"

### State 8 — Offline
- [ ] Stop the backend process
- [ ] Within the next auto-poll cycle (≤ 5 s), observe:
  - Red banner appears at top: "Sin conexión con el backend…"
  - Composer input is disabled (grayed out)
  - Send button is in disabled state
- [ ] Click "Reintentar" in the offline banner
- [ ] Start the backend again; "Reintentar" triggers a poll
- [ ] On success, offline banner disappears and green dot returns

---

## Theme Checklist

### Light theme (default)
- [ ] Background is light gray (`#f7f7f8`)
- [ ] Cards are white with light borders
- [ ] Green accent is `#25D366`
- [ ] "Persistido" badge is light green

### Kanagawa dark theme
- [ ] Click the theme toggle button (moon icon) in the header
- [ ] DevTools → Elements: verify `data-theme="kanagawa"` is set on the root `<div>`
- [ ] Background switches to `#16161D`
- [ ] Cards use `#1F1F28`
- [ ] Green accent becomes `#98BB6C`
- [ ] All text colors switch to the warm Kanagawa palette
- [ ] Click the toggle again (sun icon) → `data-theme` attribute is removed
- [ ] Light theme is fully restored

---

## Auto-Poll Checklist

- [ ] With auto-poll ON (default), DevTools Network tab shows `GET /whatsapp-messages` firing every ~5 s
- [ ] Click the "Auto" toggle to disable — polling stops (no more GET requests on the timer)
- [ ] Click "Auto" again to re-enable — polling resumes within 5 s

### Manual refresh
- [ ] With auto-poll OFF, click the refresh button (circular arrows icon in right panel header)
- [ ] Exactly one `GET /whatsapp-messages` request fires
- [ ] Right panel re-renders with the latest data

---

## Advisory Warning Checklist

- [ ] Enter `+51987654321` (valid Peru E.164): NO advisory warning shown; hint text is neutral
- [ ] Enter `+1234567890` (non-Peru): advisory warning shown below phone field
- [ ] Enter `+519` (partial, valid prefix): no warning (< 12 chars, not conclusively non-Peru)
- [ ] Enter `51987654321` (missing `+`): check `isPeru` — should match `^\+?519\d{8}$`

---

## Flow Integration Verification

Full end-to-end happy path:

1. Enter `+51987654321`, name `Test User`, text `Hola desde la consola`
2. Click send
3. Observe: bubble appears → sending state → sent state → polling → card appears in right panel
4. Verify card: initials `TU`, name `Test User`, phone `+51987654321`, text `Hola desde la consola`, "Persistido" badge
5. Inspect the wamid in the card — it should start with `wamid.`
6. Send again with same inputs — new card appears (different wamid, no duplicate omission)
