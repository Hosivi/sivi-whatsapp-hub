# Proposal: WhatsApp Inbound Webhook — Receive + Persist (Corte 2 skeleton)

## Intent

There is **no WhatsApp connection in this repo at all** — verified: no `webhooks/` module, no Meta Cloud API ingress, no `whatsapp_*` tables (only `contacts` + routing migrations exist). Corte 2 ("Conversation + task-specific AI") cannot start until the Hub can RECEIVE an inbound WhatsApp message and store it. This slice ships the minimal, secure ingress skeleton: `GET /webhooks/whatsapp` (Meta `hub.challenge` verification handshake) + `POST /webhooks/whatsapp` (validate signature → resolve tenant by `phone_number_id` → upsert contact → persist message, idempotently, always acking 200). No AI, no reply, no outbound — just trustworthy capture so later cortes build on real data.

## Scope

### In Scope
- `GET /webhooks/whatsapp` — verify handshake: echo `hub.challenge` (200, text) when `hub.mode=subscribe` + `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`; else 403.
- `POST /webhooks/whatsapp` — validate `X-Hub-Signature-256` over RAW body → Zod-parse → resolve tenant via `phone_number_id` → upsert contact (reuse `contactsRepository`) → insert message; **always 200**.
- Two new RLS tables: `whatsapp_accounts` (tenant config: `phone_number_id → tenant_id`) and `whatsapp_messages` (inbound msg + `wamid` + `raw_payload` JSONB).
- New low-privilege Postgres role + connection handle for the tenant-resolution lookup (see Decision #1).
- New `webhooks/` module (route + service + errors), env vars, app mount, migration `0002_whatsapp.sql`, Drizzle schemas, test-db extension, integration tests.

### Out of Scope (Non-goals)
- AI, auto-reply, outbound send, templates, broadcasts, payments, SUNAT, appointments, **any UI**.
- Media download (image/audio/doc bodies), non-text message handling beyond storing `raw_payload`.
- A `conversations` table (Corte 2 AI scope). Status/delivery `statuses[]` processing. **Non-Peru** phone numbers.
- ANY change to `contacts.route.ts` or coupling to the in-flight `contacts-tags-intent` change.

## Decisions (with rationale — all flagged "confirm with user")

### Decision #1 — Tenant-resolution DB handle (MOST SECURITY-SENSITIVE — confirm FIRST)
The webhook is **public + internet-facing** and Meta sends NO tenant context; the only discriminator is `phone_number_id`, resolved via a cross-tenant lookup on `whatsapp_accounts`. That lookup cannot run under `withTenant` (tenant unknown yet). The exploration suggested `adminSql` — but `client.ts` documents 4× that `adminSql` is a **superuser, migration/bootstrap ONLY, never to repositories** (lines 9, 10, 44, 66 — verified). Putting a superuser-that-bypasses-RLS in the public path is the single riskiest choice here.

- **Option 1 — Dedicated low-privilege lookup role (RECOMMENDED).** Add `app_webhook` role: `NOSUPERUSER NOBYPASSRLS`, granted ONLY `SELECT` on `whatsapp_accounts` (tenant CONFIG, not end-user data). `whatsapp_accounts` keeps its `tenant_isolation` RLS policy, so cross-tenant read needs an explicit narrow policy allowing `app_webhook` to read config rows. Add a 3rd handle to `DbClient` (`lookupSql` / `resolveTenant(phoneNumberId)`) + grant in `0002_whatsapp.sql`. Keeps RLS-from-commit-1 intact; superuser NEVER touches the public surface. Mirrors the existing `app_rls` role pattern exactly (`0000_contacts.sql:56`).
- **Option 2 — Reuse `adminSql`.** Lower effort (no new role/handle), but contradicts the documented invariant 4×, exposes a superuser in the public path, and weakens posture. If chosen it MUST be a single read-only, single-column, heavily-commented exception.

**Recommendation: Option 1.** _Confirm with user — this is the first thing to review._

### Other decisions (sensible defaults; user reviews next)
2. **Signature verification NOW** (Node `crypto.createHmac('sha256', WHATSAPP_APP_SECRET)`, no new dep). Read RAW body via `c.req.arrayBuffer()` BEFORE `c.req.json()` (Hono consumes the stream on first read). Mismatch → log + **200** (never 401; Meta retries non-200). _Confirm._
3. **Ack-fast contract**: handler returns **200 in ALL cases** — domain error, DB error, unknown `phone_number_id`, bad signature → log + 200. Non-200 triggers Meta retry storms + duplicates. _Confirm._
4. **Idempotency**: `whatsapp_messages.wamid TEXT UNIQUE` + `ON CONFLICT (wamid) DO NOTHING`. Re-delivery is a no-op. _Confirm._
5. **Persistence model**: 2 tables, both `tenant_id` + `tenant_isolation` RLS from commit 1 + grants. Message links to existing `contacts` via phone upsert (reuse `contactsRepository.create`). NO conversations table. _Confirm._
6. **Phone scope**: Peru-only — reuse `normalizePhoneE164` (`apps/backend/src/contacts/phone-e164.ts`); `from` (`wa_id`, digits) gets `+` prepended. Non-Peru fails normalization → explicit non-goal. _Confirm._
7. **Status webhooks**: same endpoint receives `statuses[]`; skeleton early-returns 200 when `value.messages` is absent/empty. _Confirm._
8. **Size/delivery**: ~515 lines, over the 400 budget. Likely 2-PR split (PR1 migration+schemas+env+mount ~155; PR2 route+service+errors+tests ~360). **Flag only — decided at the Review Workload Guard after `sdd-tasks`, NOT here.**

## Capabilities

> This section is the CONTRACT between proposal and specs phases.

### New Capabilities
- `whatsapp-webhook`: public Meta Cloud API ingress — GET verification handshake + POST inbound-message capture (signature validation, ack-fast 200, status-event skip).
- `whatsapp-accounts`: tenant↔WhatsApp-number config (`phone_number_id → tenant_id`) and the low-privilege tenant-resolution lookup that backs the public webhook.
- `whatsapp-messages`: idempotent persistence of inbound messages (by `wamid`) linked to a `contacts` row, with full `raw_payload` for auditability.

### Modified Capabilities
- None. The webhook is additive in a new `webhooks/` module; `contacts` repository is reused read-only via its existing factory; `contacts.route.ts` is untouched.

## Approach

**Flow** (`POST`): read raw bytes → verify `X-Hub-Signature-256` (mismatch → log+200) → Zod-validate → if no `value.messages` → 200 (status event) → extract `phone_number_id` from `entry[0].changes[0].value.metadata` → **resolve tenant** via the dedicated `app_webhook` lookup handle (Decision #1); unknown → log+200 → normalize `from` to E.164 → `withTenant(tenantId, …)`: `contactsRepository.create({ phone, fullName, source: 'whatsapp' })` (handles upsert/resurrection) → `INSERT INTO whatsapp_messages … ON CONFLICT (wamid) DO NOTHING` → **200**. **Wiring**: `createWhatsappWebhookRoute(deps)` — plain Hono sub-router, NO tenant middleware, mounted in `buildApp` parallel to `/contacts` (matches `createHealthRoute` shape). The route receives `{ db, env }`; `DbClient` gains the lookup handle. **RLS**: both tables `ENABLE`+`FORCE` RLS with `tenant_isolation`; domain writes go through `withTenant` (no `WHERE tenant_id` ever). **Migration**: `0002_whatsapp.sql` appended to `MIGRATION_FILES` in BOTH `migrate.ts` and `test/_helpers/test-db.ts`; carries the drizzle-kit RLS-erase warning header.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/backend/src/config/env.ts` | Modified | Add `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (+ lookup-role URL if Option 1) to the Zod schema |
| `apps/backend/src/db/client.ts` | Modified | Add low-privilege `lookupSql` handle + `resolveTenant(phoneNumberId)` (Option 1) |
| `apps/backend/src/app.ts` | Modified | Mount `/webhooks/whatsapp` parallel to `/contacts` (no tenant middleware) |
| `apps/backend/src/db/schema/whatsapp-accounts.schema.ts` | New | Drizzle schema: tenant↔phone_number_id config |
| `apps/backend/src/db/schema/whatsapp-messages.schema.ts` | New | Drizzle schema: inbound message + wamid + raw_payload |
| `apps/backend/drizzle/0002_whatsapp.sql` | New | 2 tables + RLS policies + `app_webhook` role/grant + warning header |
| `apps/backend/src/db/migrate.ts` | Modified | Append `0002_whatsapp.sql` to `MIGRATION_FILES` |
| `apps/backend/src/webhooks/whatsapp.route.ts` | New | GET handshake + POST handler (raw body, ack-fast) |
| `apps/backend/src/webhooks/whatsapp.service.ts` | New | resolve tenant → upsert contact → insert message |
| `apps/backend/src/webhooks/whatsapp.errors.ts` | New | `WebhookError` union |
| `apps/backend/test/_helpers/test-db.ts` | Modified | Append migration, extend `truncate`, seed wa-account helper |
| `apps/backend/test/webhooks/whatsapp.route.int.test.ts` | New | Integration tests (handshake, signature, tenant resolution, idempotency, status-skip, isolation) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Superuser (`adminSql`) on a public webhook path | High (if Option 2) | **Option 1**: dedicated `app_webhook` `NOBYPASSRLS` role, `SELECT`-only on config; superuser never in public path — confirm with user |
| Raw body consumed before HMAC compute | Med | Read `c.req.arrayBuffer()` BEFORE `c.req.json()`; compute HMAC over raw bytes, parse JSON from the same buffer |
| `drizzle-kit generate` erases hand-appended RLS/role block | Med | `0002_whatsapp.sql` carries the same warning header as `0000_contacts.sql:4-6`; never regenerate without re-appending |
| Non-Peru `wa_id` fails `normalizePhoneE164` | Med (by design) | Peru-only is an explicit non-goal; failed normalization → log+200, no crash |
| Non-200 to Meta causes retry storm / duplicates | Med | Ack-fast: 200 in ALL cases; `wamid UNIQUE` + `ON CONFLICT DO NOTHING` absorbs re-delivery |
| Cross-tenant lookup leaks config across tenants | Low | `app_webhook` reads only `whatsapp_accounts` (config, not user data) via a narrow explicit policy; never used for domain reads/writes |
| Coupling with in-flight `contacts-tags-intent` | Low | New `webhooks/` module only; `contacts.route.ts` untouched; reuse `contactsRepository` read-only |
| ~515-line diff over the 400 budget | Med | Flagged for the Review Workload Guard after `sdd-tasks` (likely PR1 schema/migration + PR2 route/tests) |

## Rollback Plan

Code: revert the new `webhooks/` module, the two Drizzle schemas, the `env.ts`/`app.ts`/`client.ts`/`migrate.ts` edits, the test-db extension, and the test file. DB: `0002_whatsapp.sql` is additive and idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`, role `IF NOT EXISTS` guard). To fully undo, drop `whatsapp_messages`, `whatsapp_accounts`, and the `app_webhook` role (no other table references them). The `contacts` table and all prior behavior are unaffected — no capability regresses.

## Dependencies

- Meta Cloud API app configured with the webhook URL + verify token + app secret (operational prerequisite for live traffic; tests use fixtures).
- Existing `contactsRepository` factory and `normalizePhoneE164` (`apps/backend/src/contacts/`), `withTenant`/`DbClient` (`apps/backend/src/db/client.ts`), migration runner + Testcontainers helper.
- Node `crypto` (built-in — no new dependency).

## Review Workload Forecast

- Estimated changed lines: env ~6; client ~25; app ~6; wa-accounts schema ~30; wa-messages schema ~40; `0002_whatsapp.sql` ~80; migrate ~2; route ~95; service ~75; errors ~16; test-db ~25; integration test ~160. **Total ≈ 515 changed lines (~355 prod + ~160 tests).**
- **400-line budget risk: High**
- **Chained PRs recommended: Yes** — clean split: PR1 = migration + Drizzle schemas + env + client handle + app mount (~155, foundation, independently shippable); PR2 = route + service + errors + tests (~360).
- **Decision needed before apply: Yes** — over budget. Resolve at the Review Workload Guard after `sdd-tasks` (2-PR split recommended, or justified `size:exception`). NOT decided here.

## Success Criteria

- [ ] `GET /webhooks/whatsapp` echoes `hub.challenge` (200, text) on valid `hub.verify_token`; rejects (403) otherwise.
- [ ] `POST` with valid `X-Hub-Signature-256` resolves tenant by `phone_number_id`, upserts the contact, and persists the message; returns 200.
- [ ] Bad signature, unknown `phone_number_id`, status-only event, malformed payload, and DB error each return **200** (logged, no throw to Meta).
- [ ] Re-delivering the same `wamid` is a no-op (`ON CONFLICT DO NOTHING`); contact upsert is idempotent.
- [ ] Both new tables have `tenant_isolation` RLS; tenant resolution uses the low-privilege lookup handle (Decision #1), domain writes use `withTenant` (no `WHERE tenant_id`); superuser never on the public path.
- [ ] `webhooks/` module does not import or modify `contacts.route.ts`; zero coupling to `contacts-tags-intent`.

## Open Questions for the User

1. **Decision #1 — confirm Option 1** (dedicated `app_webhook` low-privilege `SELECT`-only role + new `DbClient` lookup handle) over Option 2 (reuse superuser `adminSql`)? This is the security crux.
2. Confirm `X-Hub-Signature-256` verification ships NOW (not deferred), with mismatch → log + 200.
3. Confirm the ack-fast contract: webhook returns 200 in ALL cases (incl. errors and unknown numbers).
4. Confirm the persistence model: 2 RLS tables, message↔contact link via phone upsert, NO conversations table.
5. Confirm Peru-only phone scope (non-Peru `wa_id` is an explicit non-goal).
6. Delivery preference if over budget: 2-PR split (schema/migration first, then route/tests) or a single PR with `size:exception`? (Final call after `sdd-tasks`.)
