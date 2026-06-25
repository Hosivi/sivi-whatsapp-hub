# Verification Report — whatsapp-inbound-test-ui (dev console)

> Change: whatsapp-inbound-test-ui
> Phase: sdd-verify
> Mode: Strict TDD (backend WU-1..5) + documented manual exception (web WU-6..8)
> Artifact store: hybrid
> Verdict: PASS — merge-ready
> Date: 2026-06-24

---

## Executive Summary

The implementation is sound and merge-ready. All 40 tasks are checked done and match the code on disk.
pnpm test is green (exit 0): backend 23 test files / 227 tests passed (baseline 206 + 21 net-new), plus
turbo reports 3/3 packages successful (contracts + backend + web). Every load-bearing security claim was
verified by reading the source, not trusting the summary. 0 CRITICAL, 2 WARNING, 3 SUGGESTION.

---

## Test Evidence

    > vitest run && turbo test
    Test Files  23 passed (23)
         Tests  227 passed (227)
      Duration  68.48s
    Tasks: 3 successful, 3 total (contracts, backend, web)
    exit code: 0

21 net-new backend tests added by this change:
- env.test.ts: +2 (ENABLE_DEV_ENDPOINTS default false / coerces true)
- sign-payload.test.ts: +6 (HMAC round-trip, schema-valid, wamid non-empty, wamid uniqueness, secret-absence)
- webhook-sign.route.int.test.ts: +6 (404 flag-off, 200 shape, 400 missing-text, wamid-unique, CORS-on, CORS-off)
- whatsapp-messages.route.int.test.ts: +4 (401, empty, DESC order, RLS isolation)
- seed-dev.test.ts: +3 (one row + deleted_at NULL, idempotent re-run, constants exported)

---

## Adversarial Verification (load-bearing claims)

### 1. HMAC byte-identity — VERIFIED
- sign-payload.ts:116 computes createHmac sha256 over Buffer.from(rawBody), digest hex, prefixed sha256-equals.
- The REAL resolveSignature (whatsapp.service.ts:107-118) computes the identical HMAC over Buffer.from(rawBody), hex-decodes the header, and timingSafeEquals. Same algorithm, same key.
- sign-payload.ts:120 returns the EXACT canonical string it signed (payload = rawBody), not the object.
- sign-payload.test.ts:32-48 feeds the returned payload string back through the REAL resolveSignature and asserts true. Test passed.
- Web api.ts:56-68 postWebhook sends payloadString VERBATIM as body with no JSON.stringify round-trip. page.tsx:108 passes the canonical payload string straight from the proxy response to postWebhook. No byte mutation possible.

### 2. Prod-inert gating — VERIFIED
- app.ts:77-80: both the cors middleware and the /dev route mount are inside the if (deps.env.ENABLE_DEV_ENDPOINTS) block. Guard is at mount/construction time, not per-request.
- webhook-sign.route.int.test.ts (a): flag-off -> POST /dev/webhook-sign returns 404 (passed).
- (f): flag-off + Origin header -> Access-Control-Allow-Origin is null (passed).
- (e): flag-on + OPTIONS + Origin http://localhost:3000 -> ACAO equals that origin (passed).
- Both the 404 AND the CORS-absent are independently proven.

### 3. RLS isolation — VERIFIED
- whatsapp-messages.repository.ts:53-80: query runs inside withTenant(tenantId, tx), NO explicit WHERE tenant_id anywhere (grep confirms only comments mention the phrase, never code).
- whatsapp-messages.route.ts:39 mounts tenantMiddleware on all paths; tenant.middleware.ts:30-31 returns 401 MISSING_TENANT with no X-Tenant-Id.
- whatsapp-messages.route.int.test.ts (a) 401, (d) tenant A sees zero tenant-B rows — both passed.

### 4. Secret hygiene — VERIFIED
- Grep of apps/backend/src/dev and sign-payload.ts: zero console/logger calls. Only WHATSAPP_APP_SECRET references are comments plus one line passing it into the pure function (webhook-sign.route.ts:73).
- webhook-sign.route.ts:78-85 returns only payload, signatureHeader, wamid — secret never in body.
- sign-payload.test.ts:102-113 asserts the secret appears in neither payload nor signatureHeader. Passed.

### 5. wamid uniqueness — VERIFIED
- sign-payload.ts:64: wamid is the literal wamid-dot prefix plus crypto.randomUUID() per call.
- sign-payload.test.ts:88-100 (two identical-input calls differ) and webhook-sign.route.int.test.ts (d) (route-level two-call differ) both passed. Defeats ON CONFLICT (wamid) DO NOTHING no-op on resend.

---

## Spec Compliance Matrix

| Requirement | Covering evidence | Status |
|---|---|---|
| Dev Endpoint Guard | webhook-sign.route.int.test.ts (a)/(b); app.ts:77-80 mount-time guard | PASS |
| Dev CORS Gating | webhook-sign.route.int.test.ts (e)/(f) | PASS |
| POST /dev/webhook-sign Signing Proxy | webhook-sign.route.int.test.ts (b)/(c)/(d) + sign-payload.test.ts (6 unit) | PASS |
| GET /whatsapp-messages Tenant-Scoped Read-Back | whatsapp-messages.route.int.test.ts (a)/(b)/(c)/(d) | PASS |
| Dev Seed | seed-dev.test.ts (a)/(b) + constants test | PASS |
| Env Documentation env.example | File created per tasks/apply-progress; contents UNVERIFIABLE — sandbox permission-denied | PASS (contents unverifiable — WARNING-1) |
| Web Console Send Flow | page.tsx:83-141 (sign -> postWebhook verbatim -> poll); manual exception | PASS (manual) |
| Web Console UI States | page.tsx + HubPanel/MessageComposer; manual exception | PASS (manual) |
| Web Console Theme Toggle | page.tsx:74-80,156 + globals.css root and data-theme kanagawa; manual exception | PASS (manual) |
| Web Console Auto-Poll Toggle | page.tsx:55-71 (setInterval 5s) + onRefresh; manual exception | PASS (manual) |

All web requirements fall under the documented Out-of-Scope automated-React-tests exception (spec line 301).

---

## Design Coherence

| Decision | Code reality | Status |
|---|---|---|
| Proxy returns payload+header, does NOT self-forward | api.ts: browser does the 2nd POST | MATCH |
| GET /whatsapp-messages mirrors GET /contacts | createTenantMiddleware + listMessages | MATCH |
| Single ENABLE_DEV_ENDPOINTS flag gates dev routes + CORS | app.ts:77-80 | MATCH |
| Server-side wamid | sign-payload.ts:64 | MATCH |
| Chained dev-sign -> webhook -> persist int test | NOT a single chained test; decomposed: HMAC unit + E2E persist 2.11 + proxy isolation | DEVIATION (sound) — SUGGESTION-1 |
| tsconfig removes outDir/rootDir | rootDir/outDir/lib kept (documented) | DEVIATION (sound, non-breaking) — build passed |
| seed inserts into a tenants table | No tenants table exists; seeds whatsapp_accounts only | DEVIATION (sound) — spec only needs whatsapp_accounts |

---

## Findings

### CRITICAL — none.

### WARNING-1: env.example contents could not be verified (environment limitation)
- File: env.example (repo root)
- What: Read, Bash cat, and Grep are all permission-denied on this dotfile in the verify sandbox. The task is done and apply-progress records creation, but I could not confirm the six required keys are present nor that no real secret leaked.
- Why it matters: The Env Documentation requirement mandates all six keys and placeholder-only values. Unverifiable, not proven-wrong.
- Fix: Reviewer opens env.example manually and confirms DATABASE_URL, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, ENABLE_DEV_ENDPOINTS, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_DEFAULT_TENANT_ID are present with placeholder values only.

### WARNING-2: isPeru advisory regex accepts numbers without a leading plus
- File: apps/web/src/lib/phone.ts:24 — the regex makes the leading plus optional.
- What: The spec non-Peru scenario references a pattern requiring a leading plus; the advisory mirror makes the plus optional, so 519987654321 (no plus) passes isPeru.
- Why it matters: Cosmetic only — isPeru is advisory (file header + UI copy say so). Backend normalizePhoneE164 is the source of truth and the right panel is authoritative. No persistence behavior depends on it.
- Fix (optional): tighten the regex to require the leading plus to match the spec advisory pattern exactly.

### SUGGESTION-1: Add the chained dev-sign -> webhook -> persist integration test the design promised
- The design Testing Strategy table lists a single integration test that takes the proxy output and POSTs it to the real /webhooks/whatsapp, asserting persistence + RLS read-back. The chain is currently proven piecewise (HMAC round-trip unit + existing E2E persist + proxy isolation). A literal chained test would be the highest-fidelity guard against future byte-mutation regressions in the proxy-to-webhook seam.

### SUGGESTION-2: page.tsx writes data-theme to both the inner container and document.documentElement
- Setting documentElement dataset theme to empty string leaves an empty data-theme attribute rather than removing it. Harmless (CSS selector is data-theme kanagawa, which an empty value never matches, so light is restored correctly), but deleting the dataset key would be cleaner and match the spec removed-or-set-to-light wording precisely.

### SUGGESTION-3: Seed ON CONFLICT DO NOTHING relies on a partial unique index
- seed-dev.ts:59 uses bare ON CONFLICT DO NOTHING (no conflict target). It works because the partial unique index on phone_number_id WHERE deleted_at IS NULL catches the duplicate (idempotency test passes). If a future migration changes that index, the seed could silently start inserting duplicates. A named conflict target or a guard test on the index would harden it.

---

## Hard-Rule Compliance

| Rule | Status |
|---|---|
| No WHERE tenant_id (RLS via withTenant only) | PASS — grep clean, only comments mention it |
| Functional DI (no classes/decorators for wiring) | PASS — createDevRoute / createWhatsappMessagesRoute factories |
| Result type in domain, throw only in infra | PASS — service uses Result; routes return c.json |
| Dev endpoints prod-inert (default false) | PASS — z.coerce.boolean default false + mount-time guard |
| Code/identifiers English, UI copy Spanish | PASS — Spanish strings in components, English code |

---

## Verdict

PASS — merge-ready. Zero CRITICAL findings. The two WARNINGs are an environment-imposed verification gap (env.example unreadable in sandbox) and a cosmetic advisory-regex nuance; neither blocks merge. Recommend a reviewer eyeball env.example before merge to close WARNING-1.

Next recommended phase: sdd-archive.
