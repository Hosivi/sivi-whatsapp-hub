# Design: WhatsApp Inbound Test UI (dev console)

## Technical Approach

Approach **(a)** from the proposal: maximum-fidelity simulation. The browser never holds `WHATSAPP_APP_SECRET`. Flow:

```
apps/web page ──POST /dev/webhook-sign──▶ backend (builds + HMAC-signs Meta payload)
      │                                         │ returns { payload, signatureHeader }
      ◀─────────────────────────────────────────┘
      │
      ├──POST /webhooks/whatsapp (X-Hub-Signature-256) ─▶ REAL pipeline (HMAC→Zod→resolveTenant→withTenant→INSERT) → always 200
      │
      └──GET /whatsapp-messages (X-Tenant-Id) ─▶ withTenant SELECT (RLS) ─▶ persisted rows (SOURCE OF TRUTH; poll)
```

Three backend surfaces are added to `buildApp`, all behind a single `ENABLE_DEV_ENDPOINTS` guard except `GET /whatsapp-messages`, which mounts behind the existing tenant middleware (it is a normal RLS-scoped read, gated only by `X-Tenant-Id`). The `apps/web` Next.js 15 scaffold ports the design-reference `.dc.html` (layout + states + copy + both themes) to Tailwind, wiring the mocked behavior to these real endpoints. Backend gets full Vitest coverage; the React page is manually verified (no web test runner exists this slice — explicit exception).

## Architecture Decisions

### Decision: Signing proxy returns payload + header (does NOT self-forward)

| Option | Tradeoff | Decision |
|---|---|---|
| Proxy returns `{ payload, signatureHeader }`; browser does the second POST | 2 round-trips; but the browser exercises the REAL public webhook over HTTP (CORS, headers, body framing) exactly as Meta would | **CHOSEN** |
| Proxy itself POSTs to `/webhooks/whatsapp` server-side | 1 hop; but bypasses the browser→webhook network path and CORS, lowering fidelity, and hides the 200-always contract from the UI | Rejected |

**Rationale**: fidelity is the entire point of a test tool. The browser making the signed POST proves CORS + the public contract end-to-end. `wamid` is generated **server-side** in the proxy (`wamid.${crypto.randomUUID()}`) and returned in the payload so each send is unique (defeats `ON CONFLICT (wamid) DO NOTHING` no-op on resend). HMAC is computed by reusing the EXACT algorithm: `crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(Buffer.from(rawBody)).digest('hex')`, prefixed `sha256=` — byte-identical to `resolveSignature` in `whatsapp.service.ts`. The proxy serializes the payload to a canonical string and returns BOTH that exact string (as `payload`) and its signature, so the browser re-sends the byte-identical body the signature was computed over.

### Decision: `GET /whatsapp-messages` mirrors `GET /contacts` (tenant middleware + new repo)

| Option | Tradeoff | Decision |
|---|---|---|
| New `createWhatsappMessagesRoute(deps)` with tenant middleware + a thin `listMessages(withTenant, tenantId)` repo | Matches contacts exactly; RLS via `withTenant`; no `WHERE tenant_id` | **CHOSEN** |
| Add to webhook router | Webhook router has NO tenant middleware by design (tenant comes from `phone_number_id`); wrong layer | Rejected |

**Rationale**: a read-back endpoint is a normal tenant-scoped domain read. Query is `withTenant(tenantId, tx => tx.select().from(whatsappMessagesTable).orderBy(desc(receivedAt)).limit(50))` — RLS isolates the tenant, NO explicit `WHERE tenant_id`. Always mounted (not dev-gated): it is harmless without dev endpoints and the UI needs it.

### Decision: Single env flag `ENABLE_DEV_ENDPOINTS` gates BOTH dev routes and CORS

**Rationale**: one prod-inert guard. `ENABLE_DEV_ENDPOINTS=false` (default) → no `/dev/*`, no CORS middleware → prod-safe. Uses `hono/cors` (built into Hono, no new dep).

## File Changes

| File | Action | Description |
|---|---|---|
| `apps/backend/src/config/env.ts` | Modify | Add `ENABLE_DEV_ENDPOINTS: z.coerce.boolean().default(false)` |
| `apps/backend/src/app.ts` | Modify | When `deps && env.ENABLE_DEV_ENDPOINTS`: `app.use('*', cors({origin: ['http://localhost:3000']}))` + `app.route('/dev', createDevRoute(deps))`. Always mount `app.route('/whatsapp-messages', createWhatsappMessagesRoute(deps))` |
| `apps/backend/src/dev/webhook-sign.route.ts` | New | `createDevRoute(deps)` → `POST /webhook-sign` |
| `apps/backend/src/webhooks/sign-payload.ts` | New | Pure `buildSignedMetaPayload(input, appSecret)` → `{ payload, signatureHeader }`; reuses HMAC algorithm |
| `apps/backend/src/whatsapp-messages/whatsapp-messages.route.ts` | New | `createWhatsappMessagesRoute(deps)` + tenant middleware |
| `apps/backend/src/whatsapp-messages/whatsapp-messages.repository.ts` | New | `listMessages(withTenant, tenantId)` — RLS read, no WHERE tenant_id |
| `apps/backend/src/db/seed-dev.ts` | New | Idempotent seed: tenant + live `whatsapp_accounts` row |
| `apps/backend/package.json` | Modify | Add `"seed:dev": "tsx src/db/seed-dev.ts"` |
| `.env.example` | New (repo root) | All vars incl. `ENABLE_DEV_ENDPOINTS`, dev tenant/phone ids |
| `apps/web/**` | New | Next.js 15 scaffold (see tree) |

## Interfaces / Contracts

### `POST /dev/webhook-sign` (dev-gated)
Request: `{ phone: string, profileName?: string, text: string, phoneNumberId?: string }`
Response `200`: `{ payload: string (canonical JSON to POST verbatim), signatureHeader: string ("sha256=…"), wamid: string }`
`phoneNumberId` defaults to `env`-seeded dev value. Server builds the Meta `entry[0].changes[0].value` shape (`metadata.phone_number_id`, `contacts[0].profile.name`, `messages[0]={id:wamid, from:phone, timestamp, type:'text', text:{body:text}}`).

### `GET /whatsapp-messages` (tenant middleware)
Header: `X-Tenant-Id: <uuid>`. Response `200`: `{ data: MessageDTO[] }`, ordered `received_at DESC`, `limit 50`.
```ts
type MessageDTO = { wamid: string; name: string | null; phone: string; text: string | null; type: string; receivedAt: string /*ISO*/ };
```
`name` from joined contact (`full_name`) or null; `phone` = `from_phone_e164`. Maps to the design card fields (initials derived client-side).

### `apps/web` file tree
```
apps/web/
  package.json            @sivihub/whatsapp-hub-web; next@15, react@19, react-dom@19; dev deps: tailwindcss, postcss, autoprefixer, @types/*, typescript
  tsconfig.json           extends ../../tsconfig.base.json; OVERRIDES module:"esnext", moduleResolution:"bundler", jsx:"preserve", noEmit:true, plugins:[{name:"next"}]; composite:false; removes outDir/rootDir
  next.config.ts          export default {} satisfies NextConfig
  postcss.config.mjs      { plugins: { tailwindcss:{}, autoprefixer:{} } }
  tailwind.config.ts      content: ['./src/**/*.{ts,tsx}']; theme extends fontFamily geist/geistMono
  components.json          shadcn config (style:default, cssVars:true)
  .env.local.example      NEXT_PUBLIC_API_URL=http://localhost:3001 ; NEXT_PUBLIC_DEFAULT_TENANT_ID=<seed uuid>
  src/app/layout.tsx      <html><body className={geist}> + globals; loads Geist + Geist Mono via next/font/google
  src/app/globals.css     @tailwind base/components/utilities + the :root + [data-theme="kanagawa"] CSS-var blocks ported verbatim from the design
  src/app/page.tsx        "use client" — the console page (state machine below)
  src/lib/api.ts          signWebhook(), postWebhook(), getMessages() — fetch wrappers reading NEXT_PUBLIC_API_URL/TENANT_ID
  src/lib/phone.ts        norm(p) + isPeru(/^\+?519\d{8}$/) advisory mirror of normalizePhoneE164
  src/components/*.tsx     Header, OfflineBanner, ClientSimulator, MessageComposer, HubPanel, MessageCard, WarningBanner
```
`tsconfig.json` override is the critical fix: the base uses `module:NodeNext`/`moduleResolution:NodeNext`, which breaks Next 15 — local override to `esnext`/`bundler` is mandatory.

## Design → Tailwind mapping
- Both themes ported as raw CSS variables in `globals.css`: `:root{…light…}` + `[data-theme="kanagawa"]{…dark…}` (copy the exact var blocks from the `.dc.html`). Tailwind reads them via `bg-[var(--card-bg)]` arbitrary values or mapped tokens; keep the CSS vars as the single source so fidelity is exact.
- Theme switch = `document.documentElement.dataset.theme = 'kanagawa' | ''` (toggled by React state).
- Fonts: `next/font/google` Geist + Geist Mono → CSS vars `--font-geist`, `--font-geist-mono`.
- Component tree: `Header(theme/conn/tenant toggles)` · `OfflineBanner(offline)` · `<main grid>` → `ClientSimulator(phone,name,hint,chat,phoneWarn) > MessageComposer(4 button states: canSend|cantSend|sending|sent)` and `HubPanel(count,auto,refresh) > {skeleton ×3 | empty | MessageCard[]}` + `notPersisted WarningBanner`.

## Page state machine
```
draft → send(): blocks if offline | sendStatus≠idle | empty draft
  optimistic bubble (green if isPeru else warn) →
  sendStatus: idle→sending (POST /dev/webhook-sign → POST /webhooks/whatsapp) →sent (700ms) →idle
  then poll() once.
poll(): hubLoading=true → GET /whatsapp-messages → set hub[] ; if isPeru===false → show notPersisted banner ~4s
auto toggle: setInterval(poll, 5000) on; clear on off/unmount
theme toggle: light ⇄ kanagawa (data-theme)
conn toggle: offline flag — disables composer; "Reintentar" re-polls. A failed fetch sets offline=true.
```
`wamid` is server-generated (proxy), so the UI never needs to fabricate it; uniqueness is guaranteed per send.

## Testing Strategy
| Layer | What | Approach |
|---|---|---|
| Unit | `buildSignedMetaPayload` HMAC matches `resolveSignature`; payload shape Zod-valid | Vitest, no DB — feed output back through `resolveSignature` and `metaPayloadSchema` |
| Unit | `loadEnv` parses `ENABLE_DEV_ENDPOINTS` (default false, coerces "true") | extend `env.test.ts` |
| Integration | `POST /dev/webhook-sign` → take output → `POST /webhooks/whatsapp` → row persists; `GET /whatsapp-messages` returns it (RLS-scoped, tenant isolation) | Testcontainers `buildApp({db:testDb,env})` with `ENABLE_DEV_ENDPOINTS:true` |
| Integration | dev routes/CORS ABSENT when flag false (404 on `/dev/webhook-sign`) | Testcontainers, flag false |
| Integration | `seed-dev` idempotent (run twice → one row) | Testcontainers |
| Manual | `apps/web` page: all states, both themes, send→persist via polling | Documented checklist (no web runner this slice — explicit exception) |

## Migration / Rollout
No DB migration. Seed is idempotent (`ON CONFLICT DO NOTHING`). Rollout = additive; everything gated by `ENABLE_DEV_ENDPOINTS` (default false). Rollback = revert PR.

## Open Questions
- None blocking. `phone.ts` regex is advisory only; backend `normalizePhoneE164` remains the source of truth.
