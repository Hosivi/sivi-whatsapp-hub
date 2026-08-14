# Proposal: WhatsApp Outbound Send — `POST /whatsapp-send` (Corte 2, slice #1)

## Intent

The Hub can RECEIVE inbound WhatsApp messages (the `whatsapp-inbound-webhook` slice persists them) but **cannot send anything back** — verified: no Meta Cloud API egress, no `access_token` per tenant, `whatsapp_messages` stores inbound only. Corte 2 ("Conversation + task-specific AI") needs a trustworthy **outbound primitive** before any reply, echo, AI turn, or broadcast can exist. This slice ships exactly that primitive and nothing more: a manual, tenant-scoped `POST /whatsapp-send` that takes `{ to, text }`, resolves the tenant's single active WhatsApp account (its `phone_number_id` + per-tenant `access_token`), calls the official Meta Cloud API (`POST /{phone_number_id}/messages`), persists the outbound row, and returns the Meta `wamid`. No AI, no templates, no echo, no broadcast, no UI — just the foundational send call that every future trigger will invoke internally.

## Scope

### In Scope
- `POST /whatsapp-send` — tenant middleware (`X-Tenant-Id`) + Zod-validated body `{ to: string, text: string }`; on success returns `200 { wamid, status }`.
- Per-tenant outbound auth: new nullable `access_token TEXT` column on `whatsapp_accounts` (NULL = outbound not configured), protected by the existing `tenant_isolation` RLS policy.
- Outbound persistence: new `direction TEXT NOT NULL DEFAULT 'inbound'` column on `whatsapp_messages`; the send writes a row with `direction='outbound'`, the Meta `wamid`, and `from_phone_e164` = the recipient/contact phone.
- Injectable Meta client: `MetaClient` interface + `createMetaClient(version)` (real HTTP impl) + `createFakeMetaClient()` (test double) — functional DI, no class/container.
- New `whatsapp-send/` module (service + errors + route), migration `0003_outbound.sql`, Drizzle schema edits, app mount, env var, dev seed backfill, test-db helper extension, unit + integration tests.
- Configurable Meta API version via `WHATSAPP_META_API_VERSION` (default `v21.0`), never hardcoded.

### Out of Scope (Non-goals)
- Template messages (HSM) and template approval — only free-form text.
- AI-triggered sends, auto-echo of inbound, broadcasts, opt-in enforcement.
- **24h-window pre-validation** — Meta error `131047` is surfaced as a domain error (`WINDOW_CLOSED`); the service does NOT pre-check the window and does NOT auto-retry on 131047.
- Token encryption at rest (pgcrypto / secrets manager) — relies on RLS + disk encryption for the MVP.
- Delivery-status tracking from Meta status webhooks.
- Dev-console UI / send panel (a separate future slice; the endpoint is the deliverable).
- Multiple WhatsApp accounts per tenant — slice #1 assumes exactly one active account per tenant.
- Breaking renames (`from_phone_e164` → `contact_phone_e164`, `received_at` → `event_at`) — semantics are documented in a comment, not migrated now.

## Decisions (settled — confirmed with the user before this phase)

1. **Trigger = manual `POST /whatsapp-send`** (body `{ to, text }`, tenant from `X-Tenant-Id` middleware). This is the foundational primitive that future AI/echo/broadcast triggers call internally; building it first gives the cleanest TDD surface (a pure service over a fake Meta client) with no coupling to the inbound path. _Settled._
2. **Access-token storage = nullable `access_token TEXT` on `whatsapp_accounts`** (NULL = outbound not configured), RLS-protected by the existing `tenant_isolation` policy. Simplest pattern consistent with the schema; rotation is a single-column update; encryption-at-rest is a future concern. The token is a Meta System User permanent token (non-expiring but revocable). _Settled._
3. **Outbound persistence = add `direction TEXT NOT NULL DEFAULT 'inbound'`** to `whatsapp_messages`; outbound rows set `direction='outbound'`. Single-table conversation view is the right long-term model; existing inbound rows inherit the default. `from_phone_e164` holds the contact/recipient phone for both directions (no breaking rename now — the semantic is noted in a comment). `received_at` carries the send timestamp for outbound rows. _Settled._
4. **24h window = DEFERRED.** The service passes the send through and maps Meta error `131047` to a domain error `WINDOW_CLOSED` (surfaced, not swallowed); it does NOT pre-validate and does NOT auto-retry on 131047. Pre-checking is a duplicate read that belongs to a later AI-triggered slice. _Settled._
5. **Meta API version = env var `WHATSAPP_META_API_VERSION`** (default `v21.0`), injected into `createMetaClient(version)` — never hardcoded, so the version bumps without a code change. _Settled._
6. **Dev seed = backfill the dev `whatsapp_accounts` row with a placeholder `access_token`** (e.g. `'dev-access-token'`) so the dev path works end-to-end against the FAKE Meta client without a real Meta token. _Settled._
7. **Single account per tenant.** The send selects the tenant's one active account (`is_active = true AND deleted_at IS NULL`, via RLS-scoped `withTenant`). Multi-account selection (optional `phoneNumberId` in the body) is an explicit non-goal. _Settled._
8. **Implementation is test-first (Strict TDD active).** Pure-service unit tests (fake Meta client, no container) and integration tests (Testcontainers + fake client) are written before/with the implementation; the real HTTP Meta client is never hit in tests. _Settled._

## Capabilities

> This section is the CONTRACT between proposal and specs phases.

### New Capabilities
- `whatsapp-send`: tenant-scoped outbound send — `POST /whatsapp-send` validates `{ to, text }`, resolves the tenant's single active account, calls the Meta Cloud API, persists the outbound message, and returns `{ wamid, status }`. Maps Meta/transport failures to a typed `WhatsappSendError` union (at minimum: `NO_ACTIVE_ACCOUNT` → 404, `OUTBOUND_NOT_CONFIGURED` (NULL token) → 409/422, `WINDOW_CLOSED` (Meta 131047) → 422, `META_API_ERROR` → 502, `NETWORK_ERROR` → 502/503, `VALIDATION_ERROR` → 422). The spec phase formalizes the exact codes and HTTP mapping.
- `meta-client`: injectable Meta Cloud API egress — `MetaClient.sendText({ phoneNumberId, accessToken, to, text })` returning `Result<{ wamid, status }, MetaSendError>`, with a configurable-version real HTTP impl (`createMetaClient`) and a controllable test double (`createFakeMetaClient`).

### Modified Capabilities
- `whatsapp-accounts`: gains a per-tenant `access_token` (nullable; NULL = outbound not configured) used as the Meta `Authorization: Bearer` credential, read RLS-scoped via `withTenant`.
- `whatsapp-messages`: gains a `direction` discriminator so the existing inbound table also stores outbound rows (single-table conversation history); inbound behavior is unchanged (default `'inbound'`).

## Approach

**Flow** (`POST /whatsapp-send`): tenant middleware sets `tenantId` from `X-Tenant-Id` → Zod-validate `{ to, text }` (422 on bad input) → `withTenant(tenantId, tx => ...)`: SELECT the single active `whatsapp_accounts` row (RLS-scoped, no `WHERE tenant_id`) → if none → `NO_ACTIVE_ACCOUNT` (404); if `access_token` is NULL → `OUTBOUND_NOT_CONFIGURED` → call `deps.metaClient.sendText({ phoneNumberId, accessToken, to, text })` → on Meta error map by `metaCode` (131047 → `WINDOW_CLOSED`, others → `META_API_ERROR`) or transport failure → `NETWORK_ERROR` → on success INSERT `whatsapp_messages` (`direction='outbound'`, `wamid` from Meta, `from_phone_e164` = recipient, `received_at` = send time) via `withTenant` → return `{ wamid, status }`. **Wiring**: `createWhatsappSendRoute(deps)` is a Hono sub-router WITH `createTenantMiddleware` (mirrors `/contacts`, `/whatsapp-messages`), mounted in `buildApp` next to the existing domain routes; it receives `{ db, metaClient, env }`. **DI**: `MetaClient` is an interface injected through `deps`; production composes `createMetaClient(env.WHATSAPP_META_API_VERSION)`, tests inject `createFakeMetaClient()`. **Result discipline**: the service returns `Result<{ wamid, status }, WhatsappSendError>` and never throws; the route maps the union to HTTP; only infra (real HTTP client) may throw, caught and turned into `NETWORK_ERROR`. **RLS**: account read and message write both go through `withTenant` — never an explicit `WHERE tenant_id`. **Migration**: `0003_outbound.sql` (additive `ALTER TABLE` for both columns + any needed `app_rls` grant note) appended to `MIGRATION_FILES` in BOTH `migrate.ts` and `test/_helpers/test-db.ts`, carrying the drizzle-kit RLS-erase warning header.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/backend/drizzle/0003_outbound.sql` | New | `ALTER whatsapp_accounts ADD access_token TEXT` + `ALTER whatsapp_messages ADD direction TEXT NOT NULL DEFAULT 'inbound'` + grant note + warning header |
| `apps/backend/src/db/schema/whatsapp-accounts.schema.ts` | Modified | Add nullable `accessToken` column |
| `apps/backend/src/db/schema/whatsapp-messages.schema.ts` | Modified | Add `direction` column + comment on `from_phone_e164`/`received_at` outbound semantics |
| `apps/backend/src/db/migrate.ts` | Modified | Append `0003_outbound.sql` to `MIGRATION_FILES` |
| `apps/backend/src/config/env.ts` | Modified | Add optional `WHATSAPP_META_API_VERSION` (default `v21.0`) to the Zod schema |
| `apps/backend/src/meta/meta-client.ts` | New | `MetaClient` interface + `createMetaClient(version)` (real HTTP) + `createFakeMetaClient()` (test double) |
| `apps/backend/src/whatsapp-send/whatsapp-send.service.ts` | New | Pure service: resolve account → call Meta → persist outbound; `Result<T,E>` |
| `apps/backend/src/whatsapp-send/whatsapp-send.errors.ts` | New | `WhatsappSendError` union + Result→HTTP mapper |
| `apps/backend/src/whatsapp-send/whatsapp-send.route.ts` | New | `POST /whatsapp-send` + tenant middleware + Zod body |
| `apps/backend/src/app.ts` | Modified | Compose `createMetaClient` + mount `/whatsapp-send` |
| `apps/backend/src/db/seed-dev.ts` | Modified | Backfill dev `whatsapp_accounts.access_token` placeholder |
| `apps/backend/test/_helpers/test-db.ts` | Modified | Append migration; extend `seedWhatsappAccount` with optional `accessToken` |
| `apps/backend/test/whatsapp-send/whatsapp-send.service.test.ts` | New | Unit tests over `createFakeMetaClient()` (pure Vitest, no container) |
| `apps/backend/test/whatsapp-send/whatsapp-send.int.test.ts` | New | Integration tests (Testcontainers + fake Meta client) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Sending outside the 24h window → WABA quality hit | Med | `131047` mapped to `WINDOW_CLOSED` and surfaced (never swallowed, never auto-retried); pre-validation deferred to a later slice; slice #1 is manual/low-volume |
| Access token stored plaintext in Postgres | Med | RLS `tenant_isolation` + self-hosted disk encryption for the MVP; pgcrypto/secrets-manager flagged as a future hardening (explicit non-goal) |
| Meta System User token revoked → all sends fail | Low | Revocation returns a Meta API error mapped to a domain error and surfaced to the caller; no silent retry; admin-alerting is a future concern |
| `from_phone_e164` name is misleading for outbound rows | Low (by design) | Keep the column as "the contact's phone" for both directions; document the semantic in a schema comment; breaking rename is an explicit non-goal |
| `drizzle-kit generate` erases the hand-written RLS/grant block | Med | `0003_outbound.sql` carries the same warning header as prior migrations; never regenerate without re-appending |
| Tenant has multiple active accounts (future) | Low | Slice #1 assumes one active account; selection by `phoneNumberId` is a non-goal — spec defines behavior if >1 row is found (recommend `NO_ACTIVE_ACCOUNT`/explicit error rather than silent first-pick) |
| Real Meta HTTP client accidentally hit in tests | Low | All tests inject `createFakeMetaClient()`; the real `createMetaClient` is composed only in `app.ts` production wiring |

## Rollback Plan

Code: revert the new `whatsapp-send/` and `meta/` modules, the two schema edits, and the `env.ts`/`app.ts`/`migrate.ts`/`seed-dev.ts`/`test-db.ts` changes plus the two test files. DB: `0003_outbound.sql` is additive (`ALTER TABLE ... ADD COLUMN`) and reversible — to fully undo, `ALTER TABLE whatsapp_accounts DROP COLUMN access_token` and `ALTER TABLE whatsapp_messages DROP COLUMN direction`. Inbound capture, contacts, and all prior behavior are untouched — no capability regresses (the `direction` default keeps existing reads valid).

## Dependencies

- A Meta System User permanent `access_token` per tenant + the WABA `phone_number_id` (operational prerequisite for LIVE sends; tests use the fake client and the dev seed placeholder).
- Existing `whatsapp_accounts`/`whatsapp_messages` tables, `withTenant`/`DbClient` (`apps/backend/src/db/client.ts`), `createTenantMiddleware`, the migration runner, and the Testcontainers helper (`createTestDb`).
- `fetch` (Node 22 built-in) for the real Meta client — no new runtime dependency.

## Review Workload Forecast

- Estimated changed lines (per-file): `0003_outbound.sql` ~25; wa-accounts schema ~5; wa-messages schema ~10; migrate ~2; env ~5; `meta-client.ts` ~75; `whatsapp-send.service.ts` ~70; `whatsapp-send.errors.ts` ~25; `whatsapp-send.route.ts` ~55; app ~8; seed-dev ~4; test-db ~8; service unit test ~90; integration test ~130. **Total ≈ 510 changed lines (~290 prod + ~220 tests).**
- **400-line budget risk: Medium** (prod alone is ~290, well within budget; the total is pushed over by the test suite, which is low-risk to review).
- **Chained PRs recommended: No (likely single PR).** This is one cohesive primitive; the migration + schema + Meta client + service + route + tests form an atomic unit that is not meaningfully shippable in halves. If the reviewer prefers, a clean split exists (PR1 = migration + schemas + env + Meta client; PR2 = service + route + tests), but the recommended path is a single PR with a `size:exception` justified by the test-heavy diff.
- **Decision needed before apply: Maybe** — the total nudges over 400 due to tests. Resolve at the Review Workload Guard after `sdd-tasks`: single PR with `size:exception` (recommended) or the 2-PR split above.

## Success Criteria

- [ ] `POST /whatsapp-send` with a valid `{ to, text }` and a configured account returns `200 { wamid, status }`, calls the Meta client exactly once with the tenant's `phone_number_id` + `access_token`, and persists one `whatsapp_messages` row with `direction='outbound'` and the Meta `wamid`.
- [ ] No active account for the tenant → `404` (`NO_ACTIVE_ACCOUNT`); `access_token` is NULL → a distinct "outbound not configured" error; invalid body → `422`.
- [ ] Meta error `131047` maps to `WINDOW_CLOSED` (422) and is surfaced, NOT swallowed and NOT auto-retried; other Meta/transport failures map to typed errors with no DB write.
- [ ] The Meta API version comes from `WHATSAPP_META_API_VERSION` (default `v21.0`) — never hardcoded.
- [ ] Account read and message write both go through `withTenant` (no `WHERE tenant_id`); tenant isolation holds under `app_rls` in integration tests; the service returns `Result<T,E>` and never throws.
- [ ] Unit tests use `createFakeMetaClient()` (no container); integration tests use Testcontainers + the fake client; the real Meta HTTP client is never called in tests.

## Open Questions for the User

These are genuinely undecided (everything in "Decisions" is already settled); the spec phase can default them if there is no objection:

1. **Multi-active-account edge**: if a tenant somehow has >1 active account, should the send return an explicit error (recommended) or silently pick the first? (Default: explicit error / treat as misconfiguration.)
2. **NULL-token HTTP code**: should "outbound not configured" (NULL `access_token`) be `409 Conflict` or `422 Unprocessable Entity`? (Default: `422`, consistent with the other config-validation errors.)
3. **Delivery preference if over budget**: single PR with a justified `size:exception` (recommended) or the 2-PR split (Meta client/migration first, then service/route/tests)? Final call after `sdd-tasks` at the Review Workload Guard.
