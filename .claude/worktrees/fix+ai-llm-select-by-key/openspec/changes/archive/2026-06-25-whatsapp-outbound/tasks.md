# Tasks — whatsapp-outbound

> Change: whatsapp-outbound
> Artifact store: hybrid
> Status: tasks
> Strict TDD: ACTIVE (`pnpm test`)
> Delivery: single PR (see Review Workload Forecast — `size:exception` justified)

---

## Dependency graph (sequential unless marked PARALLEL)

```
WU-1 (migration + schemas + env)
  └─ WU-2 (MetaClient — tests then impl)
       └─ WU-3 (whatsapp-send errors + pure unit tests)
            └─ WU-4 (whatsapp-send service + unit tests)
                 ├─ WU-5 (route + AppDeps wiring — tests then impl)
                 │    └─ WU-6 (integration tests: full route scenarios)
                 │         └─ WU-7 (regression: fix existing buildApp call sites)
                 └─ WU-8 (seed-dev token backfill) [PARALLEL with WU-5..7]
```

WU-8 (seed-dev backfill) is independent of WU-5 through WU-7 and can land in parallel once WU-4 is done (the schema column exists after WU-1). In practice it ships in the same commit as WU-1 or WU-5 since the column must exist first.

---

## Work Unit 1 — Migration, Drizzle schemas, env var

> Spec refs: whatsapp-accounts delta §"access_token Column (ADDED)"; whatsapp-messages delta §"direction Column (ADDED)"; meta-client spec §"API Version from Environment"

- [x] **WU-1.1** Create `apps/backend/drizzle/0003_outbound.sql`.
  - File starts with the drizzle-kit RLS-erase warning header (mirrors `0002_whatsapp.sql`).
  - Comment block explains: existing TABLE-level grants on both tables cover the new columns; `app_webhook` column-scoped grant is unchanged (does NOT include `access_token`); RLS policies are table-scoped and cover new columns automatically — NO new GRANT or policy line needed.
  - `ALTER TABLE "whatsapp_accounts" ADD COLUMN IF NOT EXISTS "access_token" text;`
  - `ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "direction" text NOT NULL DEFAULT 'inbound';`
  - Both statements use `IF NOT EXISTS` (idempotent; Postgres 9.6+).

- [x] **WU-1.2** Append `'0003_outbound.sql'` to `MIGRATION_FILES` in `apps/backend/src/db/migrate.ts` (line 39).

- [x] **WU-1.3** Append `'0003_outbound.sql'` to `MIGRATION_FILES` in `apps/backend/test/_helpers/test-db.ts` (line 60, the `as const` tuple).

- [x] **WU-1.4** Update `apps/backend/src/db/schema/whatsapp-accounts.schema.ts`:
  - Add `accessToken: text('access_token')` to `whatsappAccountsTable` (nullable — no `.notNull()`).
  - Add `readonly accessToken: string | null` to `WhatsappAccount` type.
  - Add `accessToken: row.accessToken ?? null` to `mapRowToWhatsappAccount`.
  - Update schema docblock: remove "no per-row secret columns exist" note; add note explaining `access_token` holds the per-tenant Meta System User Bearer token (NULL = outbound not configured; never logged).

- [x] **WU-1.5** Update `apps/backend/src/db/schema/whatsapp-messages.schema.ts`:
  - Add `direction: text('direction').notNull().default('inbound')` to `whatsappMessagesTable`.
  - Add `readonly direction: string` to `WhatsappMessage` type.
  - Add `direction: row.direction` to `mapRowToWhatsappMessage`.
  - Update schema docblock: remove "stores inbound messages only" note; add outbound semantics comment explaining `from_phone_e164` holds the CONTACT/RECIPIENT phone for both directions and `received_at` carries the SEND timestamp for outbound rows (no rename — semantic documented here, migrated later).

- [x] **WU-1.6** Add `WHATSAPP_META_API_VERSION: z.string().min(1).default('v21.0')` to `envSchema` in `apps/backend/src/config/env.ts`.

**Commit**: `feat(db): add outbound migration 0003, schema columns, and WHATSAPP_META_API_VERSION env`

---

## Work Unit 2 — MetaClient interface, real impl, fake (test-first)

> Spec refs: meta-client spec §all requirements

- [x] **WU-2.1** Create `apps/backend/test/meta/meta-client.test.ts` (FAILING, no impl yet).
  Tests to write (pure Vitest, no network):
  - `createFakeMetaClient()` default returns `ok({ wamid: 'wamid-fake-1', status: 'accepted' })`.
  - `createFakeMetaClient()` with `queueError({ metaCode: 131047 })` returns `err({ code: 'META_API_ERROR', metaCode: 131047 })`.
  - `createFakeMetaClient()` records calls: `fake.calls` contains exactly one entry with the passed `SendTextInput` after one `sendText` call.
  - `createFakeMetaClient()` satisfies `MetaClient` type (TypeScript compilation test — use `const _: MetaClient = fake`).
  - Verify no network request is made (no real `fetch` mock needed — the fake simply never calls `fetch`).

- [x] **WU-2.2** Create `apps/backend/src/meta/meta-client.ts` (make WU-2.1 tests pass).
  - Export types: `SendTextInput`, `SendTextResult`, `MetaSendError` (union: `META_API_ERROR` | `NETWORK_ERROR`), `MetaClient`.
  - Export `createMetaClient(version: string): MetaClient` — real `fetch` impl targeting `https://graph.facebook.com/${version}/${phoneNumberId}/messages`; Authorization header uses Bearer token (NOT logged); on 2xx parse `messages[0].id` as `wamid`; on non-2xx parse `error.code` → `err({ code: 'META_API_ERROR', metaCode, detail })`; on `fetch` throw → `err({ code: 'NETWORK_ERROR', cause })`. Never logs `accessToken`.
  - Export `createFakeMetaClient(response?: Result<SendTextResult, MetaSendError>): MetaClient & { calls: SendTextInput[]; queueError(e: MetaSendError): void }` — default ok response; `queueError` sets the next response; `calls` array records each `sendText` invocation; no network.
  - Use `ok`/`err` from `../shared/result.js`.

- [x] **WU-2.3** Confirm `pnpm test` is green for WU-2.1 tests.

**Commit**: `feat(meta): MetaClient interface, real fetch impl, and fake test double`

---

## Work Unit 3 — Error union + pure mapper unit tests (test-first)

> Spec refs: whatsapp-send spec §"Meta Error Mapping"; design §"Error Union + HTTP Mapping"

- [x] **WU-3.1** Create `apps/backend/test/whatsapp-send/whatsapp-send.errors.test.ts` (FAILING, no impl yet).
  Tests to write (pure Vitest, no I/O):
  - `sendErrorToHttpStatus('NO_ACTIVE_ACCOUNT')` → `404`.
  - `sendErrorToHttpStatus('OUTBOUND_NOT_CONFIGURED')` → `422`.
  - `sendErrorToHttpStatus('WINDOW_CLOSED')` → `422`.
  - `sendErrorToHttpStatus('META_API_ERROR')` → `502`.
  - `sendErrorToHttpStatus('NETWORK_ERROR')` → `502`.
  - `sendErrorToHttpStatus('DB_ERROR')` → `500`.
  - TypeScript exhaustiveness: assign the switch result to a variable typed as `404 | 422 | 502 | 500` — TS compile fails if any case is missing.
  - `mapMetaError` pure function tests (if extracted): `NETWORK_ERROR` → `{ code: 'NETWORK_ERROR' }`; `META_API_ERROR` with `metaCode: 131047` → `{ code: 'WINDOW_CLOSED' }`; `META_API_ERROR` with `metaCode: 190` → `{ code: 'META_API_ERROR' }`.

- [x] **WU-3.2** Create `apps/backend/src/whatsapp-send/whatsapp-send.errors.ts` (make WU-3.1 tests pass).
  - Export `WhatsappSendError` discriminated union: `NO_ACTIVE_ACCOUNT` | `OUTBOUND_NOT_CONFIGURED` | `WINDOW_CLOSED` | `META_API_ERROR` | `NETWORK_ERROR` | `DB_ERROR` (with optional `cause`).
  - Export `sendErrorToHttpStatus(error: WhatsappSendError): 404 | 422 | 502 | 500` — exhaustive switch; TS will flag missing cases.
  - Export `mapMetaError(e: MetaSendError): WhatsappSendError` — `NETWORK_ERROR` → `{ code: 'NETWORK_ERROR' }`; `META_API_ERROR` with `metaCode === 131047` → `{ code: 'WINDOW_CLOSED' }`; else → `{ code: 'META_API_ERROR' }`.

- [x] **WU-3.3** Confirm `pnpm test` is green for WU-3.1 tests.

**Commit**: `feat(whatsapp-send): WhatsappSendError union, HTTP mapper, and pure unit tests`

---

## Work Unit 4 — sendWhatsappText service (test-first)

> Spec refs: whatsapp-send spec §all requirements; design §"Service Flow"

- [x] **WU-4.1** Create `apps/backend/test/whatsapp-send/whatsapp-send.service.test.ts` (FAILING, no impl yet).
  Tests to write (pure Vitest — inject fake `withTenant` and `createFakeMetaClient`; no Testcontainers):

  Account resolution (inject an in-memory `withTenant` stub):
  - `resolveActiveAccount` with 0 rows → service returns `err({ code: 'NO_ACTIVE_ACCOUNT' })` (no Meta call).
  - `resolveActiveAccount` with 2 rows → service returns `err({ code: 'NO_ACTIVE_ACCOUNT' })` (>1 = misconfig; no Meta call).
  - `resolveActiveAccount` with 1 row, `accessToken = null` → service returns `err({ code: 'OUTBOUND_NOT_CONFIGURED' })` (no Meta call).
  - Verify Meta is NOT called in the three error cases above.

  Meta invocation:
  - Valid account + fake Meta default ok → `deps.meta.sendText` called ONCE with `{ phoneNumberId, accessToken, to, text }` matching input.
  - `fake.calls[0].accessToken` must equal the account row's `accessToken` (token threads through correctly).

  Meta error mapping (fake queues each error):
  - Meta returns `err({ code: 'META_API_ERROR', metaCode: 131047 })` → service returns `err({ code: 'WINDOW_CLOSED' })`.
  - Meta returns `err({ code: 'META_API_ERROR', metaCode: 190 })` → service returns `err({ code: 'META_API_ERROR' })`.
  - Meta returns `err({ code: 'NETWORK_ERROR' })` → service returns `err({ code: 'NETWORK_ERROR' })`.

  Success path:
  - Meta ok → service returns `ok({ wamid: 'wamid-fake-1', status: 'accepted' })`.

  DB_ERROR path (simulate write tx failure):
  - Meta ok, but write tx throws → service returns `err({ code: 'DB_ERROR' })`.

- [x] **WU-4.2** Create `apps/backend/src/whatsapp-send/whatsapp-send.service.ts` (make WU-4.1 tests pass).
  - Export `SendInput = { readonly to: string; readonly text: string }`.
  - Export `SendOk = { readonly wamid: string; readonly status: string }`.
  - Export `resolveActiveAccount(withTenant: TenantRunner, tenantId: string): Promise<Result<{ phoneNumberId: string; accessToken: string }, WhatsappSendError>>` — `SELECT phone_number_id, access_token FROM whatsapp_accounts WHERE is_active = true AND deleted_at IS NULL LIMIT 2` inside `withTenant`; `rows.length === 0` → `NO_ACTIVE_ACCOUNT`; `rows.length > 1` → `NO_ACTIVE_ACCOUNT`; `accessToken === null` → `OUTBOUND_NOT_CONFIGURED`; else `ok(...)`. RLS scopes via `withTenant` — NO `WHERE tenant_id`.
  - Export `sendWhatsappText(deps: AppDeps, tenantId: string, input: SendInput): Promise<Result<SendOk, WhatsappSendError>>`:
    1. Call `resolveActiveAccount(deps.db.withTenant, tenantId)` — return early on error.
    2. Call `deps.meta.sendText({ phoneNumberId, accessToken, to: input.to, text: input.text })` — NO open tx; map error via `mapMetaError`.
    3. On success: `withTenant(tenantId, async (tx) => { upsertContactTx(tx, tenantId, { phone: input.to, source: 'whatsapp' }) → contactId; INSERT whatsapp_messages (direction='outbound', wamid, phoneNumberId, contactId, fromPhoneE164=input.to, messageType='text', textBody=input.text, rawPayload=Meta response JSONB, receivedAt=now()) ON CONFLICT (wamid) DO NOTHING })`; any throw → `err({ code: 'DB_ERROR', cause })`.
    4. Return `ok({ wamid, status })`.
  - Uses `upsertContactTx` from `../contacts/contacts.repository.js`.
  - Never throws outside the infra boundary. Never logs `accessToken`.
  - Uses raw SQL (`sql as rawSql` from `drizzle-orm`) for the INSERT (consistent with inbound pattern).

- [x] **WU-4.3** Confirm `pnpm test` is green for WU-4.1 tests.

**Commit**: `feat(whatsapp-send): sendWhatsappText service with account resolution and pure unit tests`

---

## Work Unit 5 — Route + AppDeps wiring + main.ts composition (test-first)

> Spec refs: whatsapp-send spec §"Tenant Middleware", §"Body Validation", §"Result Discipline"; design §"Route", §"DI wiring in buildApp"

- [x] **WU-5.1** Add the route-level unit tests to `apps/backend/test/whatsapp-send/whatsapp-send.route.unit.test.ts` OR expand into the integration test file structure (FAILING until WU-5.2 done).
  Pure Vitest route tests (no Testcontainers — use `buildApp` with `createFakeMetaClient` and a stub db):
  - Missing `X-Tenant-Id` → `401` (before any body read or Meta call).
  - Body `{ text: 'Hola' }` (no `to`) → `422` with `VALIDATION_ERROR`.
  - Body `{ to: '+51987654321', text: '' }` → `422` with `VALIDATION_ERROR`.
  - Body `{ to: '987654321', text: 'Hola' }` (no leading `+`) → `422` with `VALIDATION_ERROR`.
  Note: The E.164 regex validation must be present in the Zod schema (not just `.min(1)`). Verify the `to` field uses a pattern like `/^\+[1-9]\d{1,14}$/`.

- [x] **WU-5.2** Create `apps/backend/src/whatsapp-send/whatsapp-send.route.ts`.
  - Export `createWhatsappSendRoute(deps: AppDeps): Hono`.
  - Mount `createTenantMiddleware(deps.env)` on `*`.
  - `POST /` handler: JSON-parse guard (400 on invalid JSON); `bodySchema = z.object({ to: z.string().regex(/^\+[1-9]\d{1,14}$/), text: z.string().min(1) })` (E.164 pattern enforces the non-E.164 → 422 scenario); `safeParse` failure → 422 `VALIDATION_ERROR`; call `sendWhatsappText(deps, c.get('tenantId'), parsed.data)`; map result to HTTP via `sendErrorToHttpStatus`; `DB_ERROR` body uses `INTERNAL_ERROR` (never leak `cause`); success → `200 { wamid, status }`.
  - Mirrors `contacts.route.ts` structure.

- [x] **WU-5.3** Update `apps/backend/src/app.ts`.
  - Import `MetaClient` from `./meta/meta-client.js`.
  - Add `readonly meta: MetaClient` to `AppDeps`.
  - Import `createWhatsappSendRoute` from `./whatsapp-send/whatsapp-send.route.js`.
  - Mount `app.route('/whatsapp-send', createWhatsappSendRoute(deps))` inside the `if (deps)` block, after the existing `/whatsapp-messages` mount.
  - Update the ROUTE LAYOUT JSDoc to document `POST /whatsapp-send`.

- [x] **WU-5.4** Update `apps/backend/src/main.ts`.
  - Import `createMetaClient` from `./meta/meta-client.js`.
  - Add `const meta = createMetaClient(env.WHATSAPP_META_API_VERSION)` after `const db = createDbClient(env)`.
  - Change `buildApp({ db, env })` → `buildApp({ db, env, meta })`.

- [x] **WU-5.5** Confirm `pnpm test` is green for WU-5.1 tests.

**Commit**: `feat(whatsapp-send): POST /whatsapp-send route, AppDeps.meta wiring, main.ts composition`

---

## Work Unit 6 — Integration tests (full route scenarios, Testcontainers)

> Spec refs: whatsapp-send spec ALL scenarios; whatsapp-messages delta §"Outbound Row Shape", §"direction Column — Inbound/Outbound Segregation", §"RLS Tenant Isolation"; meta-client spec §"Fake Implementation"

- [x] **WU-6.1** Extend `apps/backend/test/_helpers/test-db.ts`:
  - Update `seedWhatsappAccount` signature to accept optional `accessToken?: string | null` in its data parameter.
  - In the `adminDb.insert(whatsappAccountsTable).values(...)` call, spread `accessToken` into the values when provided (allows `null` to test the NULL-token scenario, and any non-null string to test the configured scenario).
  - This is BACKWARD COMPATIBLE — existing callers that do not pass `accessToken` continue to work (column defaults to `null`).

- [x] **WU-6.2** Create `apps/backend/test/whatsapp-send/whatsapp-send.int.test.ts`.
  Uses `createTestDb()` + `buildApp({ db: testDb, env: makeEnv(), meta: createFakeMetaClient() })`. All tests in `beforeAll` / `afterEach(truncate)` / `afterAll(teardown)` pattern matching existing integration tests.

  Scenarios to cover (one `it` block per scenario):
  - (a) **Happy path**: `seedWhatsappAccount({ accessToken: 'tok' })` + valid body `{ to: '+51987654321', text: 'Hola' }` → `200`, response `{ wamid, status }`; exactly ONE row in `whatsapp_messages` with `direction='outbound'`, `from_phone_e164='+51987654321'`, `wamid` matching response, `contact_id` NOT NULL (resolved for the recipient), `received_at` IS NOT NULL.
  - (b) **No active account** (no seed) → `404` with `NO_ACTIVE_ACCOUNT`; zero rows in `whatsapp_messages`.
  - (c) **NULL token**: `seedWhatsappAccount({ accessToken: null })` → `422` with `OUTBOUND_NOT_CONFIGURED`; zero rows; fake Meta NOT called.
  - (d) **>1 active account**: seed two rows with `is_active=true, deleted_at=null` → `422`; zero rows. (Use `adminDb` direct insert to bypass constraint — or two separate seeds if the helper allows it.)
  - (e) **Soft-deleted account excluded**: seed one row with `deleted_at = new Date()` → `404` `NO_ACTIVE_ACCOUNT`.
  - (f) **Meta 131047**: `seedWhatsappAccount({ accessToken: 'tok' })` + `createFakeMetaClient(err({ code: 'META_API_ERROR', metaCode: 131047 }))` → `422` `WINDOW_CLOSED`; zero rows in `whatsapp_messages`.
  - (g) **Other Meta error**: `createFakeMetaClient(err({ code: 'META_API_ERROR', metaCode: 190 }))` → `502` `META_API_ERROR`; zero rows.
  - (h) **Network error**: `createFakeMetaClient(err({ code: 'NETWORK_ERROR' }))` → `502` `NETWORK_ERROR`; zero rows.
  - (i) **Body validation — missing `to`**: `{ text: 'Hola' }` → `422` `VALIDATION_ERROR`; fake NOT called.
  - (j) **Body validation — non-E.164 `to`**: `{ to: '987654321', text: 'Hola' }` → `422` `VALIDATION_ERROR`.
  - (k) **Body validation — empty `text`**: `{ to: '+51987654321', text: '' }` → `422`.
  - (l) **Missing X-Tenant-Id** → `401`.
  - (m) **Tenant isolation**: tenant A seeds account + sends → 200; query `whatsapp_messages` under tenant B context → zero rows; query under tenant A → one row.
  - (n) **Inbound direction default**: after the migration, confirm existing inbound insert (via `POST /webhooks/whatsapp` with a valid signed payload) still produces a row with `direction='inbound'`.
  - (o) **direction filter segregation**: tenant A has one inbound row and one outbound row; filter by `direction='inbound'` returns exactly one; filter by `direction='outbound'` returns exactly one.

- [x] **WU-6.3** Confirm `pnpm test` is green for all WU-6.2 scenarios.

**Commit**: `test(whatsapp-send): integration tests — happy path, error branches, RLS isolation, direction`

---

## Work Unit 7 — Regression: fix existing buildApp call sites

> Spec refs: design §"Back-compat note"; testing strategy §"Regression"

- [x] **WU-7.1** Update all existing integration test files that call `buildApp({ db, env })` to add `meta: createFakeMetaClient()`. Files and locations:
  - `test/webhooks/whatsapp.route.int.test.ts` — line 188 (`buildApp({ db: testDb, env: makeEnv() })`) AND line 516 (`buildApp({ db: brokenDb, env: makeEnv() })`).
  - `test/whatsapp-messages/whatsapp-messages.route.int.test.ts` — line 113.
  - `test/webhooks/whatsapp.stub.test.ts` — lines 43 and 50 (both `buildApp({ db: mockDb, env: makeEnv() })`).
  - `test/dev/webhook-sign.route.int.test.ts` — lines 62, 76, 97, 111, 129, 146, 163, 180 (all `buildApp({ db, env: makeEnv(...) })`).
  - `test/contacts/contacts.import.int.test.ts` — line 55.
  - `test/contacts/contacts.route.int.test.ts` — lines 42, 66, 124, 183, 241, 286.
  - `test/contacts/contacts.routing.int.test.ts` — line 56.
  - In each file: import `createFakeMetaClient` from `../../src/meta/meta-client.js` (adjust relative path as needed) and pass `meta: createFakeMetaClient()`.
  - `test/health.test.ts` calls `buildApp()` (no deps) — NOT affected.

- [x] **WU-7.2** Confirm `pnpm test` is green across ALL existing suites (zero regressions).

**Commit**: `fix(tests): pass createFakeMetaClient() to all existing buildApp({ db, env }) call sites`

---

## Work Unit 8 — Dev seed token backfill (PARALLEL-eligible after WU-1)

> Spec refs: whatsapp-accounts delta §"Dev Seed Backfill"

- [x] **WU-8.1** Update `apps/backend/src/db/seed-dev.ts` — `runDevSeed` function:
  - Change the INSERT to include `access_token` column (or add a separate `UPDATE ... SET access_token = 'dev-access-token' WHERE phone_number_id = DEV_PHONE_NUMBER_ID`).
  - Preferred approach: use `INSERT ... ON CONFLICT DO NOTHING` as-is but add `access_token` to the column list with value `'dev-access-token'`; for the idempotent backfill on existing rows, add an `UPDATE whatsapp_accounts SET access_token = 'dev-access-token' WHERE phone_number_id = ${DEV_PHONE_NUMBER_ID} AND access_token IS NULL` after the INSERT (covers the case where the row already exists from a prior seed run without the column).
  - Both scenarios from spec must hold: fresh seed → `access_token = 'dev-access-token'`; repeated seed → idempotent, no error, still one row.

- [x] **WU-8.2** Confirm the existing `test/db/seed-dev.test.ts` still passes; add/update it if it tests the seed output to also assert `access_token = 'dev-access-token'` on the seeded row.

**Commit**: `feat(seed-dev): backfill dev whatsapp_accounts.access_token placeholder`

---

## Summary

| WU | Description | Tasks | Sequential / Parallel |
|----|-------------|-------|-----------------------|
| WU-1 | Migration 0003 + schemas + env | 6 | Sequential start |
| WU-2 | MetaClient (test-first) | 3 | After WU-1 |
| WU-3 | Error union + pure tests | 3 | After WU-2 |
| WU-4 | Service (test-first) | 3 | After WU-3 |
| WU-5 | Route + AppDeps wiring | 5 | After WU-4 |
| WU-6 | Integration tests | 3 | After WU-5 |
| WU-7 | Regression: fix call sites | 2 | After WU-5 |
| WU-8 | seed-dev backfill | 2 | After WU-1, parallel with WU-2..7 |
| **Total** | | **27** | |

---

## Review Workload Forecast

| Area | Estimated lines | Notes |
|------|----------------|-------|
| `drizzle/0003_outbound.sql` | ~25 | 2 ALTERs + warning header + grant comments |
| `whatsapp-accounts.schema.ts` (modify) | ~8 | 1 column + type + mapRow + docblock update |
| `whatsapp-messages.schema.ts` (modify) | ~12 | 1 column + type + mapRow + docblock update |
| `migrate.ts` (modify) | ~2 | append filename |
| `test-db.ts` (modify) | ~8 | append filename + extend seedWhatsappAccount |
| `env.ts` (modify) | ~3 | 1 var + comment |
| `src/meta/meta-client.ts` (create) | ~75 | types + real impl + fake |
| `src/whatsapp-send/whatsapp-send.errors.ts` (create) | ~30 | union + 2 mappers |
| `src/whatsapp-send/whatsapp-send.service.ts` (create) | ~70 | resolve + send + persist |
| `src/whatsapp-send/whatsapp-send.route.ts` (create) | ~55 | tenant mw + Zod + mapping |
| `src/app.ts` (modify) | ~8 | AppDeps.meta + mount + JSDoc |
| `src/main.ts` (modify) | ~4 | createMetaClient + pass to buildApp |
| `src/db/seed-dev.ts` (modify) | ~6 | token backfill + UPDATE |
| `test/meta/meta-client.test.ts` (create) | ~40 | fake sanity tests |
| `test/whatsapp-send/whatsapp-send.errors.test.ts` (create) | ~35 | mapper exhaustiveness + mapMetaError |
| `test/whatsapp-send/whatsapp-send.service.test.ts` (create) | ~70 | account resolution + Meta branches + DB_ERROR |
| `test/whatsapp-send/whatsapp-send.int.test.ts` (create) | ~140 | 15 integration scenarios |
| Regression: existing buildApp call sites (modify ~13 files) | ~30 | import + add `meta:` arg per file |
| `test/db/seed-dev.test.ts` (modify or expand) | ~8 | assert access_token on seeded row |
| **TOTAL** | **≈ 629 lines** | ~306 prod + ~323 tests |

**Estimated changed lines: ~629**
**Exceeds 400-line budget: YES**
**400-line budget risk: HIGH** (total well over 400; production code alone ~306 is within budget, but the full diff including tests is ~629)
**Chained PRs recommended: Conditional**

The design's own estimate was ~520 lines; the task decomposition here produces a slightly higher count (~629) because it enumerates the regression fixes across 13 existing test files and adds the `meta-client.test.ts` suite explicitly.

**Chained PR split (if the user decides to chain):**

| PR | Content | Approx. lines | Can merge independently? |
|----|---------|--------------|--------------------------|
| PR 1 | WU-1 (migration + schemas + env) + WU-2 (MetaClient tests+impl) + WU-3 (error union tests+impl) + WU-8 (seed-dev backfill) | ~250 | YES — additive schema + pure modules, no route mounted yet |
| PR 2 | WU-4 (service tests+impl) + WU-5 (route + wiring) + WU-6 (integration tests) + WU-7 (regression fix) | ~380 | YES — builds on PR 1; full feature complete |

**Recommendation**: The production diff (~306 lines) is within budget. The total (~629) is pushed over by the test suite. Single PR with a justified `size:exception` is the recommended path — test-heavy diffs are low review-cognitive-load and the change is a single cohesive primitive. If the reviewer prefers, use the 2-PR split above (PR1 = foundation, PR2 = behavior). Decision at the Review Workload Guard.

**Decision needed before apply: YES** — confirm `size:exception` (single PR) or accept the 2-PR split.
