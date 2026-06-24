# Tasks: WhatsApp Inbound Webhook — Receive + Persist

> Change: `whatsapp-inbound-webhook` | TDD: Strict RED→GREEN | Store: hybrid

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~653 (~415 prod + ~238 tests) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: env + migration + schemas + client + makeIdempotent + upsertContactTx + app stub → PR 2: route + service + errors + webhook integration tests |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 — Foundation | env vars + `0002_whatsapp.sql` + Drizzle schemas + `makeIdempotent` ext + `resolveTenant` + `upsertContactTx` + app mount stub + test-db helpers | PR 1 | ~257 prod lines; independently shippable; contacts tests guard the extraction |
| 2 — Ingestion Logic | `whatsapp.errors.ts` + `whatsapp.service.ts` + `whatsapp.route.ts` + full webhook integration tests covering all 22 scenarios | PR 2 | ~396 lines; targets main after PR 1 merges |

---

## Phase 1: Foundation (Slice/PR 1)

### 1.1 — Env vars (RED → GREEN)

- [ ] 1.1 **[RED]** Add `WHATSAPP_VERIFY_TOKEN: z.string().min(1)`, `WHATSAPP_APP_SECRET: z.string().min(1)`, `DATABASE_WEBHOOK_URL: z.string().min(1)`, `APP_WEBHOOK_PASSWORD: z.string().optional()` to `apps/backend/src/config/env.ts`. Run `tsc --noEmit` → RED (no `.env.test` values). Add test values to `.env.test` / test setup. Run → GREEN.

### 1.2 — Migration file (RED → GREEN)

- [ ] 1.2 **[RED]** Write assertion in `apps/backend/test/db/migrate.int.test.ts`: after applying `['0000_contacts.sql', '0001_routing.sql', '0002_whatsapp.sql']`, `whatsapp_accounts` and `whatsapp_messages` exist with all required columns, no `app_secret`/`verify_token`/`direction` columns, partial UNIQUE on `phone_number_id WHERE deleted_at IS NULL`, UNIQUE on `wamid`, `contact_id` FK NOT NULL → `contacts(id)`, RLS ENABLED+FORCED on both tables, `app_rls` grants correct, `app_webhook` role exists with NOSUPERUSER+NOBYPASSRLS. Run → RED.
- [ ] 1.3 Create `apps/backend/drizzle/0002_whatsapp.sql` with the canonical DDL from the design: 2 tables + FK + indexes + `ENABLE/FORCE ROW LEVEL SECURITY` on both + `DROP POLICY IF EXISTS` / `CREATE POLICY tenant_isolation TO app_rls` (NULLIF pattern) on both + `CREATE POLICY webhook_config_read TO app_webhook FOR SELECT USING(true)` on `whatsapp_accounts` only + `DO/EXCEPTION` `app_webhook` role guard (CREATE + ALTER password, `'testpassword'` literal) + `GRANT USAGE ON SCHEMA public TO app_webhook` + `GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_accounts TO app_rls` + `GRANT SELECT, INSERT ON whatsapp_messages TO app_rls` + `GRANT SELECT (phone_number_id, tenant_id) ON whatsapp_accounts TO app_webhook` + drizzle-kit warning header. Run migration test → GREEN.

### 1.3 — Drizzle schemas (RED → GREEN)

- [ ] 1.4 **[RED]** Add schema-shape tests (type-level + runtime) asserting the Drizzle table definitions exist and export correct TypeScript types. Run → RED.
- [ ] 1.5 Create `apps/backend/src/db/schema/whatsapp-accounts.schema.ts`: `pgTable('whatsapp_accounts', { id, tenantId, phoneNumberId, displayPhoneNumber, wabaId, isActive, createdAt, updatedAt, deletedAt })` matching the canonical DDL exactly (no secret columns). Export `WhatsappAccount` type. Run → GREEN.
- [ ] 1.6 Create `apps/backend/src/db/schema/whatsapp-messages.schema.ts`: `pgTable('whatsapp_messages', { id, tenantId, wamid, phoneNumberId, contactId (FK contacts.id NOT NULL), fromPhoneE164, messageType, textBody, rawPayload (jsonb), receivedAt, createdAt })`. Export `WhatsappMessage` type. Run → GREEN.

### 1.4 — migrate.ts: MIGRATION_FILES + makeIdempotent extension (RED → GREEN)

- [ ] 1.7 **[RED]** Add assertion to `apps/backend/test/db/migrate.int.test.ts`: confirm `makeIdempotent(sql, 'pw1', 'pw2')` rewrites the `app_webhook` CREATE and ALTER password literals in `0002_whatsapp.sql`; confirm that a 2-arg call `makeIdempotent(sql, 'pw1')` still compiles and returns unchanged `app_webhook` literal (N1 guard). Run → RED.
- [ ] 1.8 Modify `apps/backend/src/db/migrate.ts`: (a) append `'0002_whatsapp.sql'` to `MIGRATION_FILES`; (b) extend `makeIdempotent(sql, appRlsPassword, appWebhookPassword = 'app_webhook')` — 3rd param OPTIONAL with default, keeping existing 2-arg callers compiling; add the two `.replace(...)` calls for `app_webhook` CREATE and ALTER password lines (see design). (c) In `runMigration`, source `const appWebhookPassword = process.env.APP_WEBHOOK_PASSWORD ?? 'app_webhook'` and pass it as the 3rd arg. Run → GREEN. Confirm existing 2-arg call sites at `migrate.int.test.ts:35` and `migrate.routing.int.test.ts:44,117` still compile without change.

### 1.5 — DbClient: lookupSql + resolveTenant (RED → GREEN)

- [ ] 1.9 **[RED]** Add integration assertion in `apps/backend/test/db/migrate.int.test.ts` (or a new `apps/backend/test/db/client.int.test.ts`): `resolveTenant('known-phone-number-id')` returns `ok(tenantId)` when a row exists; `resolveTenant('unknown')` returns `err({ code: 'UNKNOWN_PHONE_NUMBER_ID' })`; connecting as `app_webhook` and running `SELECT phone_number_id, tenant_id FROM whatsapp_accounts` succeeds; `SELECT *` is denied (permission error); `SELECT` on `whatsapp_messages` is denied; `SELECT` on `contacts` is denied. Run → RED.
- [ ] 1.10 Modify `apps/backend/src/db/client.ts`: add a PRIVATE `lookupSql` const created from `env.DATABASE_WEBHOOK_URL`; add `resolveTenant(phoneNumberId: string): Promise<Result<string, WebhookLookupError>>` to `DbClient` type and implementation — SELECT explicit columns `(phone_number_id, tenant_id)` NEVER `SELECT *`; 0 rows → `err({ code: 'UNKNOWN_PHONE_NUMBER_ID' })`; else `ok(row.tenant_id)`. Close `lookupSql` in `close()`. `lookupSql` is NOT exposed on `DbClient`. Run → GREEN.

### 1.6 — upsertContactTx extraction (RED → GREEN — zero CRUD regression)

- [ ] 1.11 **[RED — no-regression guard]** Run existing contacts integration tests (`pnpm test -- contacts`) with NO code changes → confirm all GREEN (establishes the baseline that must stay green after the extraction).
- [ ] 1.12 **[RED]** Add test in `apps/backend/test/contacts/contacts.repository.int.test.ts` (or a new file): `upsertContactTx` with a LIVE existing contact returns `ok(existingContact)` (no `CONTACT_ALREADY_EXISTS`); `upsertContactTx` with a soft-deleted contact resurrects it and returns `ok(resurrectedContact)`; `upsertContactTx` with a new phone inserts and returns `ok(newContact)`; `create()` with a LIVE duplicate still returns `err({ code: 'CONTACT_ALREADY_EXISTS' })` (behavior unchanged). Run → RED (helper missing).
- [ ] 1.13 Modify `apps/backend/src/contacts/contacts.repository.ts` ADDITIVELY: extract `export const upsertContactTx = async (tx: PostgresJsDatabase, tenantId: string, input: NewContactInput): Promise<Result<Contact, ContactError>>` — SELECT by phoneE164 → if live reuse → if soft-deleted resurrect UPDATE RETURNING → INSERT with 23505 catch → re-SELECT live (concurrent insert). Rewrite `create()` to call `upsertContactTx` inside its existing `withTenant` but PRESERVE its public semantics: if the helper returns a row whose phone was already a LIVE contact, `create()` returns `err({ code: 'CONTACT_ALREADY_EXISTS' })`. Run → GREEN. Confirm ALL existing contacts tests still GREEN.

### 1.7 — app.ts mount stub (RED → GREEN)

- [ ] 1.14 **[RED]** Add test asserting `GET /webhooks/whatsapp` returns a non-404 (stub response acceptable). Run → RED.
- [ ] 1.15 Modify `apps/backend/src/app.ts`: add `app.route('/webhooks/whatsapp', createWhatsappWebhookRoute(deps))` inside the `if (deps)` block, parallel to `/contacts`. Import `createWhatsappWebhookRoute` from `./webhooks/whatsapp.route.js`. This requires the route file to exist (create as a stub returning 501 for now if Phase 2 not yet shipped). Run → GREEN.

### 1.8 — test-db.ts helpers (RED → GREEN)

- [ ] 1.16 **[RED]** Add test asserting `seedWhatsappAccount` inserts a row and the `app_webhook` connection successfully resolves it. Run → RED.
- [ ] 1.17 Modify `apps/backend/test/_helpers/test-db.ts`: (a) append `'0002_whatsapp.sql'` to `MIGRATION_FILES`; (b) extend `truncate()` to include `TRUNCATE TABLE whatsapp_messages, whatsapp_accounts RESTART IDENTITY CASCADE`; (c) add `app_webhook` connection (`postgresql://app_webhook:testpassword@{host}:{port}/{db}`); (d) export `seedWhatsappAccount({ phoneNumberId, tenantId, displayPhoneNumber, wabaId })` helper using admin SQL. Run → GREEN.

### 1.9 — PR 1 static analysis

- [ ] 1.18 Run `tsc --noEmit` scoped to `apps/backend` — fix all type errors (especially the optional 3rd param on `makeIdempotent`, `resolveTenant` return type, `upsertContactTx` signature). Stage only Slice 1 files.
- [ ] 1.19 Run `biome check --write` on Slice 1 changed files only — fix lint/format. On Windows, `biome --write` may reformat CRLF; stage only the slice's files.
- [ ] 1.20 Run `pnpm test` — all existing tests GREEN + all new Phase 1 tests GREEN. Commit with `feat(whatsapp): foundation — migration, schemas, resolveTenant, upsertContactTx`.

---

## Phase 2: Ingestion Logic (Slice/PR 2)

### 2.1 — Error union

- [ ] 2.1 Create `apps/backend/src/webhooks/whatsapp.errors.ts`: export `WhatsappWebhookError = { code: 'BAD_SIGNATURE' } | { code: 'UNKNOWN_PHONE_NUMBER_ID' } | { code: 'NO_MESSAGES' } | { code: 'INVALID_PHONE' } | { code: 'DB_ERROR'; cause?: unknown }`. All variants map to HTTP 200. No throws escape.

### 2.2 — Route + Service (RED → GREEN — all 22 spec scenarios)

- [ ] 2.2 **[RED — GET handshake]** Write integration tests in `apps/backend/test/webhooks/whatsapp.route.int.test.ts`:
  - Spec §GET: valid `hub.mode=subscribe` + matching `hub.verify_token` → 200 + plain-text `hub.challenge`. (Scenario: valid subscribe)
  - Spec §GET: wrong `hub.verify_token` → 403. (Scenario: wrong token)
  - Spec §GET: absent `hub.verify_token` → 403. (Scenario: absent token)
  Run → RED.
- [ ] 2.3 Create `apps/backend/src/webhooks/whatsapp.route.ts`: `createWhatsappWebhookRoute(deps)` — Hono sub-router, NO tenant middleware. `GET`: read `hub.mode`, `hub.verify_token`, `hub.challenge`; if mode === `'subscribe'` and token matches `env.WHATSAPP_VERIFY_TOKEN` → `c.text(challenge, 200)`; else `c.text('Forbidden', 403)`. POST handler delegating to `handleInboundMessage` (stub until 2.5). Run GET tests → GREEN.
- [ ] 2.4 **[RED — signature verification]** Add tests:
  - Spec §POST-sig: valid `X-Hub-Signature-256` computed with global `WHATSAPP_APP_SECRET` → processing continues (no 200 from sig fail path). (Scenario: valid signature)
  - Spec §POST-sig: incorrect HMAC → 200, zero `whatsapp_messages` rows, event logged. (Scenario: bad signature)
  - Spec §POST-sig: absent header → 200, zero rows. (Scenario: absent signature)
  - Spec §POST-sig: length-mismatch on buffers MUST NOT throw out of handler (wrap in try/catch). (Spec: timingSafeEqual length guard)
  - Spec §raw-body: raw body read BEFORE JSON parse (arrayBuffer first). Run → RED.
- [ ] 2.5 Create `apps/backend/src/webhooks/whatsapp.service.ts`: `handleInboundMessage(deps, rawBody, sigHeader)` → `resolveSignature(rawBuffer, sigHeader, appSecret)` pure fn (strip `sha256=`, length-check, `timingSafeEqual` in try/catch → never throws out) → Zod parse → if no `value.messages` → `err({ code: 'NO_MESSAGES' })` → extract `phone_number_id` → `deps.db.resolveTenant(phoneNumberId)` → `normalizePhoneE164(waId)` → `withTenant(tenantId, tx => upsertContactTx + INSERT … ON CONFLICT (wamid) DO NOTHING)` → `ok({ wamid, contactId })`. Route POST maps ALL errors to 200 (ack-fast). Run signature tests → GREEN.
- [ ] 2.6 **[RED — Zod parse]** Add tests:
  - Spec §Zod: malformed JSON (correctly signed) → 200, zero rows, logged. (Scenario: malformed JSON)
  - Spec §Zod: valid JSON but wrong structure (no `entry` array) → 200, zero rows. (Scenario: Zod-invalid structure)
  Run → RED. Implement Zod schema for Meta payload in service. Run → GREEN.
- [ ] 2.7 **[RED — status-only skip]** Add test:
  - Spec §status-skip: correctly signed POST where `value.statuses: [...]` and no `value.messages` → 200, zero rows, no contact upsert. (Scenario: status-only event)
  Run → RED. Ensure `NO_MESSAGES` branch returns before resolution. Run → GREEN.
- [ ] 2.8 **[RED — tenant resolution]** Add tests:
  - Spec §resolve: known `phone_number_id` → `ok(tenantId)`. (Scenario: known phone resolves)
  - Spec §resolve: unknown `phone_number_id = '99999'` → 200, zero rows, logged, no contact upsert. (Scenario: unknown phone_number_id)
  Run → RED. Wire `resolveTenant` into service. Run → GREEN.
- [ ] 2.9 **[RED — phone normalization + contact upsert]** Add tests:
  - Spec §upsert: new Peru `wa_id = '51987654321'` → contact inserted with `source='whatsapp'`, `whatsapp_messages` row with `contact_id` NOT NULL. (Scenario: new Peru wa_id)
  - Spec §upsert: LIVE contact already exists for `phone_e164 = '+51987654321'` → `upsertContactTx` returns `ok(existingContact)`, message row with `contact_id = existingContact.id`. (Scenario: existing live contact reused)
  - Spec §upsert: non-Peru `wa_id = '1234567890'` → 200, no row in `contacts`, no row in `whatsapp_messages`, logged. (Scenario: non-Peru wa_id)
  Run → RED. Wire `normalizePhoneE164` + `upsertContactTx` in service. Run → GREEN.
- [ ] 2.10 **[RED — idempotent wamid]** Add tests:
  - Spec §idempotent: first delivery → exactly one `whatsapp_messages` row for `wamid='wamid_abc'`. (Scenario: first delivery)
  - Spec §idempotent: re-delivery of same `wamid` → still exactly one row, no error, 200. (Scenario: re-delivery, ON CONFLICT DO NOTHING)
  Run → RED. Confirm INSERT uses `ON CONFLICT (wamid) DO NOTHING`. Run → GREEN.
- [ ] 2.11 **[RED — happy path E2E]** Add test:
  - Spec §happy-path: known `phone_number_id='111'`, signed POST, Peru `from='51987654321'`, `wamid='wamid_001'` → 200, contact exists/reused under tenant A, exactly one `whatsapp_messages` row with `contact_id` NOT NULL, `raw_payload` contains original message object. No `WHERE tenant_id` in queries — RLS via `withTenant` only. (Scenario: valid signed POST full persistence)
  Run → RED → GREEN.
- [ ] 2.12 **[RED — DB error resilience]** Add test:
  - Spec §db-error: force a DB failure during the transaction (constraint violation on insert) → 200, no `whatsapp_messages` row for `wamid`, no orphaned contact, error logged. (Scenario: DB error, tx rollback)
  Run → RED → GREEN.
- [ ] 2.13 **[RED — tenant isolation on messages]** Add tests:
  - Spec §isolation: message stored under tenant A → queried as `app_rls` with tenant B GUC → zero rows; queried as tenant A → row visible. (Scenario: tenant A message invisible to tenant B)
  - RLS: `app_webhook` cannot SELECT on `whatsapp_messages` (permission denied). (Spec §app_webhook role boundary)
  Run → RED → GREEN.
- [ ] 2.14 **[RED — contacts.create() no-regression]** Add test (if not already in 1.12):
  - `contacts.create()` with a live duplicate still returns `err({ code: 'CONTACT_ALREADY_EXISTS' })` — existing contacts integration tests must stay GREEN after `upsertContactTx` extraction. (Spec §upsertContactTx, zero CRUD regression)
  Run → RED → GREEN.
- [ ] 2.15 **[RED — makeIdempotent 2-arg callers no-regression (N1)]** Confirm (compile-only) that `apps/backend/test/db/migrate.int.test.ts:35` and `apps/backend/test/db/migrate.routing.int.test.ts:44,117` still compile without the 3rd arg and produce no TS error. Run `tsc --noEmit` → must be GREEN.
- [ ] 2.16 **[RED — route isolation]** Add test:
  - `POST /webhooks/whatsapp` is mounted WITHOUT tenant middleware; `POST /contacts` remains unaffected. Confirm `contacts.route.ts` has zero imports from `webhooks/`. (Spec §route isolation)

### 2.3 — PR 2 static analysis + final gate

- [ ] 2.17 Run `tsc --noEmit` across `apps/backend` — fix all type errors introduced in Phase 2 (ack-fast 200 return types, `Result` exhaustiveness, Zod inferred types).
- [ ] 2.18 Run `biome check --write` on Phase 2 changed files only — fix lint/format. Stage only Slice 2 files.
- [ ] 2.19 Run `pnpm test` from repo root — all existing tests GREEN + all Phase 1 + Phase 2 tests GREEN. No regression in `contacts`, `routing`, or `migrate` suites.
- [ ] 2.20 Commit with `feat(whatsapp): inbound webhook — handshake, HMAC, upsert, idempotent persist`.
