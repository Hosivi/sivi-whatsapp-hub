# Verify Report — whatsapp-send-ui

> Change: whatsapp-send-ui
> Date: 2026-06-25
> Verdict: **PASS ✅**

## Validation evidence

- **Backend tests**: 298 passed (29 files) via `pnpm --filter @sivihub/whatsapp-hub-backend test` (with `@sivihub/contracts` built).
- **Backend typecheck**: clean (`tsc --noEmit`).
- **Web**: `pnpm --filter @sivihub/whatsapp-hub-web build` succeeds (Next.js 15, tsc + type-check internal). No web test runner (consistent with the dev-console slice) — UI logic verified by the build + adversarial review + manual `dev:local`.
- **Biome**: clean on changed files.

## Spec compliance (delta against dev-console)

All ADDED requirements implemented:
- Outbound composer (reply bar in HubPanel footer): `to` + `text` + send button (idle→sending→sent→idle; →idle on error), calls `POST /whatsapp-send`.
- Recipient advisory reuses `isPeru()` (advisory only).
- Typed error surfacing → Spanish messages for every backend code (incl. `INTERNAL_ERROR` with a no-resend warning) + generic fallback.
- Post-send poll (no optimistic insert); `outboundText` cleared on success.
- Direction-aware `MessageCard` badge ("Enviado"/"Recibido").
- `GET /whatsapp-messages` read DTO returns `direction`.
- Dev fake Meta client gated on `ENABLE_DEV_ENDPOINTS` (mock-first in dev; real client in prod).

## Adversarial review (judgment-day, light — 2 rounds)

Final: **APPROVED** — zero CRITICAL, zero confirmed real WARNINGs.

Issues found and fixed:
- **CRITICAL: `z.coerce.boolean()` footgun** — `ENABLE_DEV_ENDPOINTS="false"` coerced to `true`, which would have leaked the fake Meta client to production (sends look "Enviado ✓" but never reach WhatsApp). Fixed: gate on the literal `"true"` only (`z.string().optional().transform(v => v === 'true')`); added env tests (`'false'→false`, `'0'→false`). This also hardens the pre-existing `/dev/*` routes + CORS gating.
- `INTERNAL_ERROR` was unmapped on the frontend (DB failure after a successful Meta send) → added a no-resend Spanish message; clear `outboundText` on success — closes the duplicate-send risk.
- Outbound inputs lacked accessible names → added `aria-label`.

## Non-blocking follow-ups (documented)

- The fake-Meta-client choice is coupled to `ENABLE_DEV_ENDPOINTS`; a dedicated `USE_FAKE_META_CLIENT` flag would decouple dev-routes from fake egress (avoids silently faking sends if `ENABLE_DEV_ENDPOINTS=true` in a staging env with real accounts).
- After `INTERNAL_ERROR` the send button returns to idle (the warning advises no-resend but the UI does not enforce it; `outboundText` is cleared, partially mitigating).
- Tenant-middleware error codes (`MISSING_TENANT`, `INVALID_TENANT_ID`) fall to the generic message (not reachable from the dev console, which sends a valid tenant).
- The repository unit test exercises the row-map, not the SELECT projection.
- `setTimeout` for the "sent" state has no unmount cleanup (pre-existing pattern, mirrors inbound `handleSend`).

## Manual verification (user)

Run `pnpm --filter @sivihub/whatsapp-hub-web dev:local` (Node 25 → `dev:local`, not `dev`) with Postgres migrated + `seed:dev`, then exercise: direction badges on seeded cards, send flow, Peru advisory, `INVALID_RECIPIENT` on a non-Peru number, and confirm no real graph.facebook.com call (fake client in dev).

## Verdict: PASS ✅
