# Proposal: WhatsApp Inbound Test UI (dev console)

## Intent

The inbound webhook (`POST /webhooks/whatsapp`) is LIVE but has **no human-facing way to exercise it**. Today the only trigger is the test suite or a real Meta callback. Developers cannot type a message "as a customer" and watch it get HMAC-verified, tenant-resolved, and persisted. This change ships the FIRST `apps/web` (Next.js 15) scaffold as a **dev-only console** that proves the real reception + persistence path end-to-end, matching the imported Claude Design (`design-reference/WhatsApp-Inbound-Console.dc.html`). Success = a dev runs both servers, sends a simulated message, and sees the persisted row appear in the right panel via polling.

## Scope

### In Scope
- **Backend dev signing proxy** `POST /dev/webhook-sign` — builds + HMAC-signs a Meta payload server-side; secret never leaves the server. (approach **a**)
- **Backend read-back** `GET /whatsapp-messages` — `app_rls` + `withTenant` + `X-Tenant-Id` dev-header, mirroring `GET /contacts`.
- **Dev seed** `apps/backend/src/db/seed-dev.ts` — idempotent live `whatsapp_accounts` row mapping `phone_number_id` → tenant.
- **Env gating** `ENABLE_DEV_ENDPOINTS=true` (explicit flag, NOT NODE_ENV) + dev-only permissive CORS (:3000 → :3001) + repo-root `.env.example`.
- **`apps/web` scaffold** — Next.js 15 + React 19 + Tailwind/shadcn; tsconfig overrides (`module: esnext`, `moduleResolution: bundler`).
- **Port the design** — two-panel console (Simulador / Recibido por el Hub), all states (empty, sending, sent, persisted, not-persisted warn, offline, skeleton), UI polls GET messages as source of truth, auto-generates unique `wamid` per send.

### Out of Scope (non-goals)
- AI / outbound / auto-replies, broadcasts, templates, opt-in.
- Production readiness: real JWT auth, prod CORS, prod dashboard. This tool MUST NOT ship to prod.
- Fixing W2 (`deleted_at` filter in resolveTenant) — seed uses a live row to sidestep it.
- next-intl / full i18n framework; SSE/WebSocket live updates.

## Capabilities

### New Capabilities
- `dev-console`: dev-only inbound simulation — signing proxy, message read-back endpoint, seed, env/CORS gating, and the `apps/web` test page.

### Modified Capabilities
None. `webhooks` and `contacts` specs are unchanged — the proxy POSTs to the existing webhook unmodified; GET messages is a new endpoint, not a contract change.

## Approach

Approach **(a)** from exploration: maximum fidelity. UI → `POST /dev/webhook-sign` (signs server-side) → UI → real `POST /webhooks/whatsapp` (full HMAC + Zod + resolveTenant + withTenant pipeline) → UI polls `GET /whatsapp-messages` to confirm persistence (webhook always 200, so the right panel is the truth). All dev endpoints + CORS gated behind `ENABLE_DEV_ENDPOINTS`.

### Resolved Decisions
1. **Dark theme (kanagawa)**: IN-SCOPE. Cost is just a `[data-theme]` CSS-var block already in the design; near-zero effort, the design ships it.
2. **i18n**: Inline Spanish strings now; DEFER next-intl. Single dev page does not justify a framework.
3. **Auth**: DEV-ONLY `AUTH_MODE=dev-header` + `X-Tenant-Id`. Explicitly MUST NOT ship to prod until the JWT 501 stub is resolved.
4. **Strict TDD scope**: Backend (signing proxy, GET messages, seed) gets full Vitest coverage. React page: NO automated component test this slice (no web test runner exists; adding one is out-of-scope) — verified manually. State this exception explicitly in tasks.
5. **Injection**: Approach (a) confirmed — signing proxy + real POST.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/backend/src/app.ts` | Modified | Mount dev endpoints + dev CORS behind env guard |
| `apps/backend/src/config/env.ts` | Modified | Add `ENABLE_DEV_ENDPOINTS` (default false) |
| `apps/backend/src/db/seed-dev.ts` | New | Idempotent dev seed |
| `.env.example` | New | All required vars documented |
| `apps/web/**` | New | Next.js 15 scaffold + console page (~10-15 files) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Dev endpoints leak to prod | Med | Single `ENABLE_DEV_ENDPOINTS` guard; default false; non-goal note in PR |
| `tsconfig.base` NodeNext breaks Next.js | High | Override `module/moduleResolution` locally per Next 15 pattern |
| Re-send no-ops (`ON CONFLICT wamid`) | Med | UI generates unique `wamid` per send |
| Non-Peru phone silently dropped | Med | UI advisory warning + poll confirms (mirrors backend) |
| Single PR exceeds 400 lines | High | Accepted `size:exception` — net-new infra (see Delivery) |

## Delivery

`delivery_strategy = exception-ok` — single PR with accepted `size:exception`. This is net-new `apps/web` infrastructure and will exceed the 400-line budget; splitting net-new scaffolding adds churn without review benefit.

## Rollback Plan

Self-contained and additive. Revert the PR: deletes `apps/web/`, the seed script, `.env.example`, and the env-guarded endpoints/CORS. The webhook, contacts, schema, and migrations are untouched, so no DB or contract rollback is needed.

## Dependencies

- Running Postgres with migrations applied + `seed-dev` executed.
- `WHATSAPP_APP_SECRET` set locally (used by the signing proxy).
- One-time `shadcn init` (setup step, generates `components.json`).

## Success Criteria

- [ ] `ENABLE_DEV_ENDPOINTS=true`: dev sends a Peru message → persisted card appears in the right panel via polling.
- [ ] `wamid` is unique per send; re-send creates a new row.
- [ ] Non-Peru number shows the advisory warning and produces no persisted card.
- [ ] Dev endpoints + CORS are inert when `ENABLE_DEV_ENDPOINTS` is unset/false.
- [ ] UI reproduces the design: two panels, both themes, all listed states.
- [ ] Backend endpoints covered by Vitest; `pnpm test` green.
