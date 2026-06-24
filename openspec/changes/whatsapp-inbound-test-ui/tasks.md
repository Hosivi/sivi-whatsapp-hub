# Tasks: WhatsApp Inbound Test UI (dev console)

> Change: whatsapp-inbound-test-ui
> Artifact store: hybrid
> Delivery: exception-ok — single PR, size:exception accepted

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 700–900 (net-new: apps/web scaffold + backend surfaces + tests) |
| 400-line budget risk | High |
| Chained PRs recommended | No |
| Suggested split | Single PR — size:exception accepted (net-new infra, no existing lines deleted) |
| Delivery strategy | exception-ok |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Commit | Notes |
|------|------|--------|-------|
| WU-1 | Env flag | `feat(env): add ENABLE_DEV_ENDPOINTS flag` | `env.ts` + `env.test.ts` + `.env.example`; zero risk to production |
| WU-2 | Signing payload builder | `feat(dev): buildSignedMetaPayload + HMAC round-trip test` | Pure fn, no DB; must pass before any route test |
| WU-3 | `/dev/webhook-sign` route + CORS gating | `feat(dev): webhook-sign route, CORS, app wiring` | Depends on WU-1 + WU-2; integration tests (flag on/off) |
| WU-4 | `GET /whatsapp-messages` repo + route | `feat(whatsapp-messages): list route + RLS integration tests` | Always-mounted; depends on WU-1 for env type |
| WU-5 | `seed-dev.ts` + script | `feat(db): idempotent dev seed + idempotency test` | Depends on WU-4 fixture pattern |
| WU-6 | `apps/web` scaffold | `feat(web): Next.js 15 + Tailwind + shadcn scaffold` | package.json, tsconfig override, configs; no page logic yet |
| WU-7 | `apps/web` console page | `feat(web): dev console page — all states, both themes` | Ports design reference; depends on WU-6 |
| WU-8 | Manual verification checklist | `docs(dev-console): manual verification checklist` | Kept with the page commit or as a separate docs addendum |

---

## Phase 1: Env Flag + Documentation (WU-1)

> Spec: Dev Endpoint Guard · Env Documentation

- [x] 1.1 **[TEST]** In `apps/backend/src/config/env.test.ts`, add two cases: `ENABLE_DEV_ENDPOINTS` absent → parsed value is `false`; `ENABLE_DEV_ENDPOINTS="true"` → parsed value is `true`. Run `pnpm test` — expect RED (field not yet in schema).
- [x] 1.2 In `apps/backend/src/config/env.ts`, add `ENABLE_DEV_ENDPOINTS: z.coerce.boolean().default(false)` to `envSchema`. Run `pnpm test` — expect GREEN for the two new cases.
- [x] 1.3 Create `.env.example` at repo root with placeholder values for all six required keys: `DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `ENABLE_DEV_ENDPOINTS`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DEFAULT_TENANT_ID`. Add `DATABASE_ADMIN_URL`, `DATABASE_WEBHOOK_URL`, `AUTH_MODE`, `PORT` placeholders too. No real secrets; all values are clearly placeholder strings.

---

## Phase 2: Signing Payload Builder (WU-2)

> Spec: POST /dev/webhook-sign — Signing Proxy · Design: sign-payload.ts

- [x] 2.1 **[TEST]** Create `apps/backend/src/webhooks/sign-payload.test.ts`. Write a unit test that calls `buildSignedMetaPayload({ phone, profileName, text, appSecret })` and feeds the returned `payload` string (the canonical serialized string) back through `resolveSignature(Buffer.from(payload).buffer, signatureHeader, appSecret)` → must return `true`. Also assert: `payload` parses as valid JSON that passes `metaPayloadSchema`; `wamid` inside the payload is a non-empty string; `signatureHeader` starts with `sha256=`; two consecutive calls with identical inputs produce different `wamid` values. Run `pnpm test` — RED.
- [x] 2.2 Create `apps/backend/src/webhooks/sign-payload.ts`. Implement `buildSignedMetaPayload(input: { phone: string; profileName?: string; text: string; phoneNumberId: string; appSecret: string }): { payload: string; signatureHeader: string; wamid: string }`. The function MUST: generate `wamid = "wamid." + crypto.randomUUID()`; build the Meta-shaped object matching `metaPayloadSchema`; serialize it once via `JSON.stringify` to a canonical string `rawBody`; compute HMAC as `crypto.createHmac('sha256', appSecret).update(Buffer.from(rawBody)).digest('hex')`, prefixed `sha256=`; return `{ payload: rawBody, signatureHeader, wamid }`. The returned `payload` is a string — NOT the object — so the browser re-POSTs byte-identical body. Run `pnpm test` — GREEN.

---

## Phase 3: `/dev/webhook-sign` Route + CORS Gating (WU-3)

> Spec: Dev Endpoint Guard · Dev CORS Gating · POST /dev/webhook-sign

- [x] 3.1 **[TEST]** Create `apps/backend/test/dev/webhook-sign.route.int.test.ts`. Integration test (Testcontainers): (a) `ENABLE_DEV_ENDPOINTS=false` → `POST /dev/webhook-sign` returns `404`; (b) `ENABLE_DEV_ENDPOINTS=true` → `POST /dev/webhook-sign` with valid `{ phone, profileName, text }` returns `200` with `{ payload, signatureHeader, wamid }`; (c) flag-on + missing `text` field → `400`; (d) flag-on + `wamid` differs on two identical calls; (e) `OPTIONS /dev/webhook-sign` with `Origin: http://localhost:3000` and flag-on → response includes `Access-Control-Allow-Origin: http://localhost:3000`; (f) flag-off → no `Access-Control-Allow-Origin` on any request. Run `pnpm test` — RED.
- [x] 3.2 Create `apps/backend/src/dev/webhook-sign.route.ts`. Implement `createDevRoute(deps: AppDeps): Hono`. Define Zod input schema `{ phone: z.string(), profileName: z.string().optional(), text: z.string() }`. `POST /webhook-sign`: validate body → `400` on failure; call `buildSignedMetaPayload({ ...input, phoneNumberId: DEV_PHONE_NUMBER_ID, appSecret: env.WHATSAPP_APP_SECRET })`; return `200` with `{ payload, signatureHeader, wamid }`. `WHATSAPP_APP_SECRET` MUST NOT appear in the response body or any log call.
- [x] 3.3 Modify `apps/backend/src/app.ts`: import `cors` from `'hono/cors'` and `createDevRoute`. In `buildApp(deps?)`, when `deps && deps.env.ENABLE_DEV_ENDPOINTS`: add `app.use('*', cors({ origin: ['http://localhost:3000'] }))` before other routes; add `app.route('/dev', createDevRoute(deps))`. Run `pnpm test` — GREEN.

---

## Phase 4: `GET /whatsapp-messages` Repo + Route (WU-4)

> Spec: GET /whatsapp-messages — Tenant-Scoped Read-Back

- [x] 4.1 **[TEST]** Create `apps/backend/test/whatsapp-messages/whatsapp-messages.route.int.test.ts`. Integration test (Testcontainers): (a) `GET /whatsapp-messages` without `X-Tenant-Id` → `401`; (b) tenant A with no messages → `200 []`; (c) insert two messages for tenant A with `received_at` T1 < T2 → `200` list has T2 first; (d) insert a message under tenant B → `GET /whatsapp-messages` with `X-Tenant-Id: <tenantA>` → response contains zero messages from tenant B. Run `pnpm test` — RED.
- [x] 4.2 Create `apps/backend/src/whatsapp-messages/whatsapp-messages.repository.ts`. Implement `listMessages(withTenant: TenantRunner, tenantId: string): Promise<MessageDTO[]>`. Query: `withTenant(tenantId, tx => tx.select(...).from(whatsappMessagesTable).leftJoin(contactsTable, eq(whatsappMessagesTable.contactId, contactsTable.id)).orderBy(desc(whatsappMessagesTable.receivedAt)).limit(50))`. Map rows to `MessageDTO`. NO `WHERE tenant_id` — RLS only.
- [x] 4.3 Create `apps/backend/src/whatsapp-messages/whatsapp-messages.route.ts`. Implement `createWhatsappMessagesRoute(deps: AppDeps): Hono`. Mount the `tenantMiddleware` from `http/tenant.middleware.ts`. `GET /`: call `listMessages(deps.db.withTenant, tenantId)`; return `200 { data: messages }`. Always mount this route in `buildApp` (not dev-gated): add `app.route('/whatsapp-messages', createWhatsappMessagesRoute(deps))` in `app.ts`. Run `pnpm test` — GREEN.

---

## Phase 5: Dev Seed (WU-5)

> Spec: Dev Seed

- [x] 5.1 **[TEST]** Create `apps/backend/test/db/seed-dev.test.ts`. Integration test (Testcontainers, admin client): (a) run seed once → exactly one row in `whatsapp_accounts` for the configured `phone_number_id` with `deleted_at = NULL`; (b) run seed a second time → still exactly one row, no error thrown. Run `pnpm test` — RED.
- [x] 5.2 Create `apps/backend/src/db/seed-dev.ts`. Use admin/migration DB client. Insert a fixed row into `whatsapp_accounts` (`phone_number_id = DEV_PHONE_NUMBER_ID`, `tenant_id = DEV_TENANT_ID`, `deleted_at = NULL`) using `INSERT ... ON CONFLICT DO NOTHING`. Export the two constants (`DEV_TENANT_ID`, `DEV_PHONE_NUMBER_ID`) for use by other tests. Run `pnpm test` — GREEN.
- [x] 5.3 In `apps/backend/package.json`, add `"seed:dev": "tsx src/db/seed-dev.ts"` to the `scripts` block.

---

## Phase 6: `apps/web` Scaffold (WU-6)

> Design: apps/web file tree · tsconfig override (mandatory)

- [x] 6.1 Create `apps/web/package.json`. Name: `@sivihub/whatsapp-hub-web`. Dependencies: `next@15`, `react@19`, `react-dom@19`. Dev dependencies: `tailwindcss`, `postcss`, `autoprefixer`, `typescript`, `@types/react`, `@types/react-dom`, `@types/node`. Include `"dev": "next dev"`, `"build": "next build"`, `"start": "next start"` scripts.
- [x] 6.2 Create `apps/web/tsconfig.json`. Extends `../../tsconfig.base.json`. Override `module: "esnext"`, `moduleResolution: "bundler"`, `jsx: "preserve"`, `noEmit: true`, `plugins: [{ name: "next" }]`. Set `composite: false`. Remove `outDir`/`rootDir` (not valid with Next 15 + `noEmit`). This override is CRITICAL — the base `NodeNext` breaks Next 15.
- [x] 6.3 Create `apps/web/next.config.ts`: `export default {} satisfies NextConfig`.
- [x] 6.4 Create `apps/web/postcss.config.mjs`: `{ plugins: { tailwindcss: {}, autoprefixer: {} } }`.
- [x] 6.5 Create `apps/web/tailwind.config.ts`. Content: `['./src/**/*.{ts,tsx}']`. Extend `fontFamily` with geist and geistMono tokens.
- [x] 6.6 Create `apps/web/components.json` (shadcn config): style `default`, cssVars `true`, tailwind config and globals paths pointing to local files.
- [x] 6.7 Create `apps/web/.env.local.example`: `NEXT_PUBLIC_API_URL=http://localhost:3001`, `NEXT_PUBLIC_DEFAULT_TENANT_ID=<dev-seed-uuid-placeholder>`.
- [x] 6.8 Add `apps/web` to `pnpm-workspace.yaml` packages list if not already present. Verify Turborepo `turbo.json` includes the web app in the pipeline or add it.

---

## Phase 7: `apps/web` Console Page (WU-7)

> Spec: Web Console — Send Flow · UI States · Theme Toggle · Auto-Poll Toggle · Design: page state machine + component tree

*No automated tests for `apps/web` this slice — explicit exception per spec.*

- [x] 7.1 Create `apps/web/src/app/globals.css`. Include `@tailwind base`, `@tailwind components`, `@tailwind utilities`. Port the exact `:root { … }` CSS variable block (light theme) and `[data-theme="kanagawa"] { … }` block verbatim from `openspec/changes/whatsapp-inbound-test-ui/design-reference/WhatsApp-Inbound-Console.dc.html`. This file is the single source of truth for both palettes.
- [x] 7.2 Create `apps/web/src/app/layout.tsx`. Load Geist + Geist Mono via `next/font/google`; expose as CSS variables `--font-geist` and `--font-geist-mono`. Wrap children in `<html><body>`.
- [x] 7.3 Create `apps/web/src/lib/api.ts`. Implement three functions reading `process.env.NEXT_PUBLIC_API_URL` and `process.env.NEXT_PUBLIC_DEFAULT_TENANT_ID`: `signWebhook(phone, profileName, text)` → `POST /dev/webhook-sign`; `postWebhook(payloadString, signatureHeader)` → `POST /webhooks/whatsapp` with `X-Hub-Signature-256` header and the canonical string as body (MUST NOT re-serialize); `getMessages(tenantId)` → `GET /whatsapp-messages` with `X-Tenant-Id`. Any `fetch` network error sets the offline flag.
- [x] 7.4 Create `apps/web/src/lib/phone.ts`. Implement `isPeru(phone: string): boolean` using regex `/^\+?519\d{8}$/` (advisory mirror of backend `normalizePhoneE164`). Implement `norm(phone: string): string` (strips spaces/dashes, does not throw).
- [x] 7.5 Create `apps/web/src/components/Header.tsx`. Props: `theme`, `onThemeToggle`, `connectionStatus`, `tenantId`. Renders title, theme toggle button, connection badge. When `connectionStatus === 'offline'`, renders the offline banner inline or triggers `OfflineBanner`.
- [x] 7.6 Create `apps/web/src/components/OfflineBanner.tsx`. Full-width banner shown when `offline=true`. Includes "Reintentar" button that calls `onRetry`.
- [x] 7.7 Create `apps/web/src/components/MessageComposer.tsx`. Controlled inputs for phone + profile name + text. Shows Peru advisory warning below phone field when `isPeru(phone)` is false and phone is non-empty. Submit button cycles: `idle` → `sending` → `sent` (700 ms) → `idle`. Button is disabled when `offline`, `sendStatus !== 'idle'`, or draft is empty.
- [x] 7.8 Create `apps/web/src/components/ClientSimulator.tsx`. Composes `MessageComposer` with a left-panel chat bubble list (optimistic bubbles appended after send, green if Peru / amber if not).
- [x] 7.9 Create `apps/web/src/components/MessageCard.tsx`. Renders `name` (or phone initials), phone, message text, `receivedAt` formatted, and "Persistido" badge.
- [x] 7.10 Create `apps/web/src/components/HubPanel.tsx`. Props: `messages`, `loading`, `notPersisted`, `autoOn`, `onAutoToggle`, `onRefresh`. When `loading=true`: renders 3 shimmer skeleton cards (not empty state). When `messages.length === 0` and not loading: renders empty state. Otherwise: renders `MessageCard` list. When `notPersisted=true`: renders `WarningBanner` (transient, ~4 s auto-dismiss).
- [x] 7.11 Create `apps/web/src/components/WarningBanner.tsx`. Displays "No persistido — backend rechazó la normalización del teléfono" warning.
- [x] 7.12 Create `apps/web/src/app/page.tsx` (`"use client"`). Implements the full state machine from design: `draft`, `phone`, `profileName`, `sendStatus (idle|sending|sent)`, `hub[]`, `hubLoading`, `notPersisted`, `offline`, `autoOn`, `theme`. Send flow: (1) call `signWebhook` → `{ payload, signatureHeader }`, (2) call `postWebhook(payload, signatureHeader)` — pass canonical string, MUST NOT re-serialize, (3) `sendStatus → sent` for 700 ms then idle, (4) call `poll()` once. `poll()`: `hubLoading=true` → `getMessages(tenantId)` → set `hub[]`; if `!isPeru(phone)` show `notPersisted` banner for 4 s. Auto-poll: `setInterval(poll, 5000)` while `autoOn`; cleared on toggle or unmount. Theme toggle: `document.documentElement.dataset.theme = theme === 'light' ? 'kanagawa' : ''`. Compose `Header + OfflineBanner + <main grid> ClientSimulator + HubPanel`.

---

## Phase 8: Manual Verification Checklist (WU-8)

> Spec: all Web Console requirements · Out of scope: automated React tests

*This phase has NO automated tests by design. Manual verification is the explicit exception documented in the spec.*

- [x] 8.1 Create `apps/web/MANUAL_VERIFICATION.md`. Document step-by-step checklist covering: seed applied (`pnpm seed:dev`); backend started with `ENABLE_DEV_ENDPOINTS=true`; all 8 UI states from the spec (idle, sending, sent, loading-skeleton, persisted, not-persisted-warn, empty-right, offline); both themes (light / kanagawa — verify `data-theme` attribute in DevTools); auto-poll fires every 5 s (verify Network tab); manual refresh works when auto-poll off; non-Peru phone shows advisory warn + "no card" after send; Peru phone shows "Persistido" card; offline state disables composer + shows banner; "Reintentar" re-polls.
- [x] 8.2 Update `README.md` (repo root) or `apps/backend/README.md` with dev console run notes: install → migrate → `seed:dev` → start backend with `ENABLE_DEV_ENDPOINTS=true` → start `apps/web` → open `http://localhost:3000`.
