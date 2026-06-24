# sivi-whatsapp-hub

WhatsApp contact capture and lead routing hub — sibling service to [SiviHub CRM](../SiviHubSoftware).

## Install
pnpm install

## Dev
pnpm dev

## Test
pnpm test

## Typecheck
pnpm typecheck

## Health check
GET http://localhost:3001/health
→ { "status": "ok", "service": "sivi-whatsapp-hub", "ts": "<ISO>" }

---

## Dev Console (WhatsApp Inbound Test UI)

The dev console lets you exercise the full WhatsApp inbound path end-to-end without a real Meta callback.
It requires `ENABLE_DEV_ENDPOINTS=true` on the backend and a seeded dev tenant.

### Quick start

1. **Install**
   ```
   pnpm install
   ```

2. **Migrate DB**
   ```
   pnpm --filter @sivihub/whatsapp-hub-backend migrate
   ```

3. **Seed dev data** (idempotent — safe to run multiple times)
   ```
   pnpm --filter @sivihub/whatsapp-hub-backend seed:dev
   ```

4. **Copy env files**
   - Backend: `cp apps/backend/.env.example apps/backend/.env` — fill in `DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`
   - Web: `cp apps/web/.env.local.example apps/web/.env.local`
   - `NEXT_PUBLIC_DEFAULT_TENANT_ID` is pre-set to `00000000-0000-0000-0000-000000000001` (matches seed)

5. **Start backend** with dev endpoints enabled
   ```
   ENABLE_DEV_ENDPOINTS=true pnpm --filter @sivihub/whatsapp-hub-backend dev
   ```
   Backend listens on `http://localhost:3001`

6. **Start web console**
   ```
   pnpm --filter @sivihub/whatsapp-hub-web dev
   ```
   Open `http://localhost:3000`

### What it does

- **Left panel (Simulador de cliente)**: enter a phone number (E.164, Peru), optional profile name, and message text. Click "Enviar mensaje".
  - The browser calls `POST /dev/webhook-sign` to get a signed Meta-shaped payload (HMAC computed server-side — secret never leaves the backend).
  - The browser then posts that exact payload to `POST /webhooks/whatsapp` (the real inbound pipeline).
  - An optimistic bubble appears in the chat zone (green = Peru; amber = non-Peru).

- **Right panel (Recibido por el Hub)**: polls `GET /whatsapp-messages` every 5 s (auto-poll toggle). Shows persisted messages from the database as truth source — NOT the webhook response.

- **Themes**: click the theme button in the header to switch between Light and Kanagawa (dark).

- **Offline detection**: any failed fetch marks the app as offline, disables sending, and shows a retry banner.

### Full manual verification checklist
See `apps/web/MANUAL_VERIFICATION.md`.

### Dev endpoint security notes
- `ENABLE_DEV_ENDPOINTS=false` (default) → `/dev/*` routes are NOT registered. Safe to deploy without this flag.
- `WHATSAPP_APP_SECRET` never appears in any response body or log.
- Do NOT run with `ENABLE_DEV_ENDPOINTS=true` in production.
