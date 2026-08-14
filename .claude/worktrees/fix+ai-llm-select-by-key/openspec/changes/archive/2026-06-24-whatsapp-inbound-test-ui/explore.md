# Exploration — whatsapp-inbound-test-ui

**Phase**: sdd-explore
**Date**: 2026-06-24
**Artifact store**: hybrid (mirror of engram `sdd/whatsapp-inbound-test-ui/explore`)

## Goal

A minimal web UI to TEST/SIMULATE the WhatsApp inbound flow. The user types a
message "as a WhatsApp customer" and SEES the system receive, validate, and
persist it. This is the FIRST scaffolding of `apps/web` (Next.js 15). There is
NO outbound/AI automation yet — this UI exercises **reception + persistence**
only.

## Confirmed current state

- Inbound webhook is LIVE at `POST /webhooks/whatsapp`
  (`apps/backend/src/app.ts:68`, `whatsapp.route.ts`, `whatsapp.service.ts`).
- POST pipeline: raw body read (`whatsapp.route.ts:58`) → HMAC-SHA256 verify via
  `resolveSignature()` with `timingSafeEqual` (`whatsapp.service.ts:90-124`) →
  Zod `metaPayloadSchema` (failure → `NO_MESSAGES`) → `resolveTenant(phoneNumberId)`
  using low-privilege `app_webhook` role (`client.ts:98-118`) → single
  `withTenant` tx (`upsertContactTx` + `INSERT … ON CONFLICT (wamid) DO NOTHING`)
  → **200 in ALL cases** (ack-fast).
- GET `/webhooks/whatsapp` = Meta `hub.challenge` handshake (`WHATSAPP_VERIFY_TOKEN`).
- Meta payload shape: `entry[0].changes[0].value.messages[0] = { id, from, timestamp, type, text?: { body } }`; `metadata.phone_number_id` required; `contacts[0].profile.name` optional.
- `whatsapp_messages`: `tenant_id, wamid (UNIQUE), phone_number_id, contact_id (FK→contacts), from_phone_e164, message_type, text_body, raw_payload (JSONB), received_at`. RLS `tenant_isolation` TO `app_rls`.
- Auth: `AUTH_MODE=dev-header` → `X-Tenant-Id: <UUID>`; JWT is a 501 stub.
- No `.env.example`. No seed script. `apps/web` does NOT exist. `pnpm-workspace.yaml` globs `apps/*`. No CORS middleware on the backend.

## Core architectural fork — how the UI injects a simulated message

| Approach | Pros | Cons | Effort |
|---|---|---|---|
| **(a) Signing proxy + real POST** — backend `POST /dev/webhook-sign` builds+signs the Meta payload; UI then calls the REAL `POST /webhooks/whatsapp` | 100% real path incl. HMAC; secret stays server-side | 2 round-trips; needs env-guarded dev endpoint | Medium |
| (b) Dev bypass endpoint — skips HMAC, calls ingestion from step 3 | simplest UI | partial fidelity; prod-leak risk | Low |
| (c) Sign + invoke `handleInboundMessage` as a function | 1 round-trip; HMAC exercised | skips Hono body-read framing | Low |

**Recommendation: (a)** — this is a test tool; fidelity is the primary value.
Dev endpoint guarded by explicit `ENABLE_DEV_ENDPOINTS=true` (not NODE_ENV).
`WHATSAPP_APP_SECRET` never leaves the server.

## Read-back path

Add `GET /whatsapp-messages` behind the existing tenant middleware
(`X-Tenant-Id` dev-header, `app_rls` + `withTenant`), mirroring `GET /contacts`.
Because the webhook always returns 200, the UI CANNOT infer success from the HTTP
response — it must POLL this endpoint to confirm persistence. This read panel is
the source of truth.

## apps/web minimum scope (net-new, dominant effort)

1. `package.json` — Next.js 15, React 19, Tailwind, shadcn/ui.
2. `tsconfig.json` — extends base but overrides `module: esnext` +
   `moduleResolution: bundler` (base uses NodeNext → breaks Next.js).
3. `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`.
4. Root layout + single simulation page (form + message list).
5. `.env.local.example` — `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DEFAULT_TENANT_ID`.

## Seed / prereqs

- `apps/backend/src/db/seed-dev.ts` — idempotent INSERT of a `whatsapp_accounts`
  row mapping `phone_number_id` → tenant (must be non-deleted; see W2).
- `.env.example` at repo root (non-negotiable).
- CORS: Next.js (3000) → Hono (3001) needs a dev-gated CORS header or a Next.js
  proxy route.

## Risks / open questions for the proposal

- `apps/web` is net-new infrastructure — the largest cost; the UI logic is tiny.
- Auth model: this UI is DEV-ONLY. If it ever ships to prod, the JWT 501 stub
  must be resolved first.
- i18n: CLAUDE.md mandates Spanish UI copy via i18n; for a dev tool, inline
  Spanish vs next-intl is an open decision (likely overkill here).
- Strict TDD scope for `apps/web` is undefined.
- W2 (`resolveTenant` no `deleted_at` filter) — seed must insert a live row.
- W4 (silent 200 on all errors) — UI must poll to confirm; cannot trust HTTP.
- `wamid` uniqueness — UI must generate a unique wamid per send or re-sends
  no-op via `ON CONFLICT DO NOTHING`.
- Phone normalization — `normalizePhoneE164` silently rejects non-Peru numbers;
  UI must pre-fill a valid `+51` number and warn.

## Next recommended

`sdd-propose`.
