# Design: WhatsApp Outbound Send — `POST /whatsapp-send`

## Technical Approach

A new `whatsapp-send/` module exposes a tenant-scoped Hono sub-router mounted at `/whatsapp-send` in `buildApp`, parallel to `/contacts` and `/whatsapp-messages`, WITH `createTenantMiddleware` (tenant comes from `X-Tenant-Id`). The route Zod-validates `{ to, text }`, then calls a pure service `sendWhatsappText(deps, tenantId, { to, text })` that: (1) reads the tenant's single active `whatsapp_accounts` row via `withTenant` (RLS, no `WHERE tenant_id`), (2) guards a NULL `access_token`, (3) calls an INJECTED `MetaClient.sendText(...)` OUTSIDE any open transaction, (4) on success persists one `whatsapp_messages` row (`direction='outbound'`) via a SECOND `withTenant` transaction, and (5) returns `{ wamid, status }`. Every failure becomes a typed `WhatsappSendError` variant; the service NEVER throws (only the real HTTP client may throw, caught and mapped to `NETWORK_ERROR`). Egress is the official Meta Cloud API only, behind a small `MetaClient` interface composed in `app.ts` (`createMetaClient(version)`) and replaced by `createFakeMetaClient()` in tests. Persistence is carried by an additive `0003_outbound.sql`: one nullable column on `whatsapp_accounts`, one defaulted column on `whatsapp_messages` — no new tables, no new roles, no policy changes.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| **Meta egress = injectable interface (functional DI)** | A `MetaClient` TYPE with `sendText(...)`; `createMetaClient(version)` (real `fetch` impl) + `createFakeMetaClient()` (test double); composed in `app.ts`, threaded through `AppDeps.meta` | A class with a `send()` method; a module-level singleton; mocking the module in tests | House rule bans classes/containers/decorators for wiring (ADR-0017 functional DI). An interface + two factory functions gives a pure, deterministic test seam (`createFakeMetaClient`) and a single production composition point, with NO `vi.mock` of the HTTP module. |
| **Meta call runs OUTSIDE the DB transaction** | TWO separate `withTenant` calls: (1) read account → (2) [Meta HTTP call, no tx] → (3) persist outbound row | One `withTenant` wrapping the Meta call (read + send + insert in a single tx) | Holding a Postgres transaction (and a pooled connection) open across a network round-trip is an anti-pattern: it pins a connection for the Meta latency and risks long idle-in-transaction. Read-then-send-then-write with two short txs is correct here because there is no atomic invariant between the read and the write — the wamid only exists AFTER the send. |
| **Outbound auth = nullable `access_token` on `whatsapp_accounts`** | `ALTER TABLE whatsapp_accounts ADD COLUMN access_token TEXT` (nullable; NULL = outbound not configured); read RLS-scoped via `withTenant`; never logged | Separate `whatsapp_credentials` table; per-tenant secrets table; global env token | One column is the simplest pattern consistent with the schema; rotation is a one-column UPDATE. The token is per-tenant (each MYPE connects its OWN WABA System User token), so it CANNOT be a global env var like `WHATSAPP_APP_SECRET`. Encryption at rest (pgcrypto) is an explicit non-goal. |
| **No new grant needed for `access_token`** | The existing TABLE-level `GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_accounts" TO app_rls` (0002) already covers the new column | A new column-scoped grant for `access_token` | TABLE-level grants automatically include columns added later. The only column-scoped grant in 0002 is `app_webhook`'s `SELECT (phone_number_id, tenant_id)` — and `app_webhook` must NOT see `access_token` (it stays as-is, so the lookup role can't read the token). No grant change is required. |
| **Outbound persistence = `direction` discriminator on the existing table** | `ALTER TABLE whatsapp_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'`; outbound rows set `'outbound'` | New `whatsapp_outbound_messages` table | Single-table conversation history is the right long-term model; existing inbound rows inherit the `'inbound'` default with zero backfill, and `whatsapp-messages.repository.ts` reads keep working unchanged. The TABLE-level `GRANT SELECT, INSERT ON whatsapp_messages TO app_rls` already covers the new column. |
| **`from_phone_e164` / `received_at` reused for outbound (no rename)** | `from_phone_e164` holds the CONTACT/recipient phone for both directions; `received_at` carries the SEND timestamp for outbound rows; both semantics documented in a schema comment | Rename to `contact_phone_e164` / `event_at` now | A breaking rename touches the inbound writer, the messages repository/DTO, and the dev console — out of scope for this slice. The semantic ("the contact's phone", "the event timestamp") is coherent for both directions; document it, migrate later. |
| **`contact_id` NOT NULL FK preserved → upsert the recipient contact** | Before the outbound INSERT, run `upsertContactTx(tx, tenantId, { phone: to, source: 'whatsapp' })` (the existing additive helper) inside the SAME write tx to resolve `contact_id` | Make `contact_id` nullable for outbound; insert with a dummy contact | `whatsapp_messages.contact_id` is `NOT NULL REFERENCES contacts(id)` and the inbound path already upserts. Reusing `upsertContactTx` keeps ONE source of truth for contact resolution, keeps the FK intact, and means an outbound row links to the same contact a later inbound reply would. The upsert + insert run in one short write tx (atomic), AFTER the Meta call. |
| **24h window = surface, never pre-check** | Map Meta `131047` → `WINDOW_CLOSED` (422); do NOT pre-validate the window; do NOT auto-retry on 131047 | Pre-read last inbound timestamp before sending; auto-retry with a template | Pre-checking is a duplicate read that belongs to a later AI-triggered slice; auto-retry on a closed window risks WABA quality. Surface the error and let the caller decide. |
| **Meta API version = injected env var** | `WHATSAPP_META_API_VERSION` (optional, default `v21.0`) → `createMetaClient(version)` builds `https://graph.facebook.com/{version}/{phoneNumberId}/messages` | Hardcode `v21.0` in the client | Versions bump on a schedule; an env-injected version avoids a code change and keeps the URL construction in one place. |
| **Result → HTTP mapping in a dedicated exported mapper** | `sendErrorToHttpStatus(error): 404 | 422 | 502 | 503` in `whatsapp-send.errors.ts`, exhaustive over the union (mirrors `resultToHttpStatus` in `contacts.route.ts`) | Inline `switch` in the route handler | A dedicated exported mapper keeps the switch exhaustive (TS flags a missing case if the union grows) and is unit-testable without HTTP. Mirrors the established contacts/routing pattern. |

## Data Flow

```
POST /whatsapp-send   (tenant middleware: X-Tenant-Id → tenantId, else 401/400)
  │ Zod parse { to, text }  ──invalid──────────────────────────► 422 VALIDATION_ERROR
  ▼
sendWhatsappText(deps, tenantId, { to, text }):
  │
  ├─ TX#1  withTenant(tenantId, tx):  SELECT active account (RLS, no WHERE tenant_id)
  │        WHERE is_active = true AND deleted_at IS NULL  (LIMIT 2 → detect >1)
  │        │ 0 rows ──────────────────────────────────────────► NO_ACTIVE_ACCOUNT      (404)
  │        │ >1 row ──────────────────────────────────────────► NO_ACTIVE_ACCOUNT      (404, misconfig)
  │        │ access_token IS NULL ───────────────────────────► OUTBOUND_NOT_CONFIGURED (422)
  │        ▼ returns { phoneNumberId, accessToken }
  │
  ├─ deps.meta.sendText({ phoneNumberId, accessToken, to, text })   ← NO open tx (network call)
  │        │ Meta error 131047 ───────────────────────────────► WINDOW_CLOSED          (422)
  │        │ other Meta API error ────────────────────────────► META_API_ERROR         (502)
  │        │ network / timeout / non-JSON (client THROWS→caught)► NETWORK_ERROR         (502/503)
  │        ▼ ok { wamid, status }
  │
  └─ TX#2  withTenant(tenantId, tx):              ← atomic write (upsert + insert)
           ├─ upsertContactTx(tx, tenantId, { phone: to, source: 'whatsapp' }) → contactId
           └─ INSERT whatsapp_messages
                (direction='outbound', wamid, phone_number_id, contact_id,
                 from_phone_e164 = to, message_type='text', text_body=text,
                 raw_payload = Meta response, received_at = now())
              (any throw → tx ROLLBACK → DB_ERROR (500); the send already happened — see note)
  ▼
200 { wamid, status }
```

**Send-then-persist ordering note.** The Meta call is committed network state BEFORE the DB write; if `TX#2` fails, the message WAS sent but is not persisted (`DB_ERROR` surfaced, no rollback of the send). This is the inherent at-least-once tradeoff of any "call external API then record it" flow and is acceptable for the manual/low-volume slice #1. A future reconciliation (status webhooks, persist-pending-then-confirm) is out of scope.

## MetaClient Interface + DI Wiring

```ts
// src/meta/meta-client.ts — injectable Meta Cloud API egress (functional DI, NO class).

import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';

/** Input to a single text send. accessToken is the per-tenant Bearer credential. */
export type SendTextInput = {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly to: string;
  readonly text: string;
};

/** Success shape: Meta's wamid + the messaging status it reports. */
export type SendTextResult = {
  readonly wamid: string;
  readonly status: string; // 'accepted' (Meta echoes messages[0].id; status from response)
};

/** Egress failure union — transport vs. API error are distinguished by `metaCode`. */
export type MetaSendError =
  | { readonly code: 'META_API_ERROR'; readonly metaCode?: number; readonly detail?: string }
  | { readonly code: 'NETWORK_ERROR'; readonly cause?: unknown };

/** The injectable contract. Production = createMetaClient; tests = createFakeMetaClient. */
export type MetaClient = {
  sendText(input: SendTextInput): Promise<Result<SendTextResult, MetaSendError>>;
};

/**
 * Real HTTP impl. Builds POST https://graph.facebook.com/{version}/{phoneNumberId}/messages
 * with Authorization: Bearer {accessToken}. NEVER logs the token.
 * - 2xx          → ok({ wamid: body.messages[0].id, status: body.messages[0].message_status ?? 'accepted' })
 * - non-2xx JSON → err({ code: 'META_API_ERROR', metaCode: body.error?.code, detail: body.error?.message })
 * - fetch throws / non-JSON body → err({ code: 'NETWORK_ERROR', cause })
 */
export const createMetaClient = (version: string): MetaClient => ({
  async sendText({ phoneNumberId, accessToken, to, text }) {
    try {
      const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      });
      const body = (await res.json()) as MetaApiResponse;
      if (!res.ok) {
        return err({ code: 'META_API_ERROR', metaCode: body.error?.code, detail: body.error?.message });
      }
      const wamid = body.messages?.[0]?.id;
      if (!wamid) {
        return err({ code: 'META_API_ERROR', detail: 'missing wamid in 2xx response' });
      }
      return ok({ wamid, status: body.messages?.[0]?.message_status ?? 'accepted' });
    } catch (cause) {
      return err({ code: 'NETWORK_ERROR', cause });
    }
  },
});

/**
 * Test double. Deterministic, controllable. Default = ok({ wamid: 'wamid-fake-1', status: 'accepted' }).
 * Override the response to simulate any Meta/transport outcome; record calls for assertions.
 */
export const createFakeMetaClient = (
  response: Result<SendTextResult, MetaSendError> = ok({ wamid: 'wamid-fake-1', status: 'accepted' }),
): MetaClient & { calls: SendTextInput[] } => {
  const calls: SendTextInput[] = [];
  return {
    calls,
    async sendText(input) {
      calls.push(input);
      return response;
    },
  };
};
```

### DI wiring in `buildApp` (`app.ts`)

`AppDeps` gains a `meta: MetaClient` member. Production composes the real client from the env version; tests pass a fake. The route is mounted next to the existing tenant-scoped routes.

```ts
// app.ts
export type AppDeps = {
  readonly db: DbClient;
  readonly env: Env;
  readonly meta: MetaClient;   // NEW — injected egress
};

// inside if (deps):
app.route('/whatsapp-send', createWhatsappSendRoute(deps));

// main.ts (production composition root):
const meta = createMetaClient(env.WHATSAPP_META_API_VERSION);
const app = buildApp({ db, env, meta });
```

> **Back-compat note.** `AppDeps` currently has only `{ db, env }`. Adding a required `meta` member means every `buildApp({ db, env })` call site that exercises the deps branch must pass `meta`. The webhook/contacts/messages routes do NOT read `deps.meta`, so existing inbound/contacts integration tests pass `createFakeMetaClient()` (cheap) — `sdd-tasks` must enumerate those call sites. Alternative considered and rejected: make `meta` optional and lazy-construct in the route — rejected because optional infra deps hide wiring bugs and break the "compose once at the root" rule.

## Service Flow (`whatsapp-send.service.ts`)

```ts
// src/whatsapp-send/whatsapp-send.service.ts — pure service, Result<T,E>, NEVER throws out.

export type SendInput = { readonly to: string; readonly text: string };
export type SendOk = { readonly wamid: string; readonly status: string };

export const sendWhatsappText = async (
  deps: AppDeps,
  tenantId: string,
  input: SendInput,
): Promise<Result<SendOk, WhatsappSendError>> => {
  // 1) Resolve the single active account (RLS via withTenant — NO WHERE tenant_id).
  const accountResult = await resolveActiveAccount(deps.db.withTenant, tenantId);
  if (!accountResult.ok) return accountResult;          // NO_ACTIVE_ACCOUNT | OUTBOUND_NOT_CONFIGURED | DB_ERROR
  const { phoneNumberId, accessToken } = accountResult.value;

  // 2) Call Meta OUTSIDE any tx. Map the egress union to the send union.
  const sendResult = await deps.meta.sendText({ phoneNumberId, accessToken, to: input.to, text: input.text });
  if (!sendResult.ok) return err(mapMetaError(sendResult.error));   // WINDOW_CLOSED | META_API_ERROR | NETWORK_ERROR
  const { wamid, status } = sendResult.value;

  // 3) Persist the outbound row (upsert recipient contact + insert) in one short write tx.
  try {
    await deps.db.withTenant(tenantId, async (tx) => {
      const contact = await upsertContactTx(tx, tenantId, { phone: input.to, source: 'whatsapp' });
      if (!contact.ok) throw new Error(`upsertContactTx failed: ${contact.error.code}`);
      await tx.execute(rawSql`
        INSERT INTO whatsapp_messages
          (tenant_id, wamid, phone_number_id, contact_id, from_phone_e164,
           message_type, text_body, raw_payload, received_at, direction)
        VALUES
          (${tenantId}::uuid, ${wamid}, ${phoneNumberId}, ${contact.value.id}::uuid, ${input.to},
           'text', ${input.text}, ${JSON.stringify({ wamid, status })}::jsonb, now(), 'outbound')
        ON CONFLICT (wamid) DO NOTHING
      `);
    });
  } catch (cause) {
    return err({ code: 'DB_ERROR', cause });   // send already happened; surface, no rollback of the send
  }

  return ok({ wamid, status });
};
```

- **`resolveActiveAccount(withTenant, tenantId)`** — a small repository fn in `whatsapp-send.repository.ts` (or inline in the service): `SELECT phone_number_id, access_token FROM whatsapp_accounts WHERE is_active = true AND deleted_at IS NULL LIMIT 2` inside `withTenant`. `rows.length === 0 || rows.length > 1` → `NO_ACTIVE_ACCOUNT`; `access_token === null` → `OUTBOUND_NOT_CONFIGURED`; else `ok({ phoneNumberId, accessToken })`. RLS scopes the read; `LIMIT 2` is the cheap "exactly one" guard.
- **`mapMetaError(e: MetaSendError): WhatsappSendError`** — `e.code === 'NETWORK_ERROR'` → `{ code: 'NETWORK_ERROR' }`; `e.code === 'META_API_ERROR' && e.metaCode === 131047` → `{ code: 'WINDOW_CLOSED' }`; else `{ code: 'META_API_ERROR' }`. Pure, unit-testable.

## Error Union + HTTP Mapping

```ts
// src/whatsapp-send/whatsapp-send.errors.ts
export type WhatsappSendError =
  | { readonly code: 'NO_ACTIVE_ACCOUNT' }                    // 0 or >1 active accounts
  | { readonly code: 'OUTBOUND_NOT_CONFIGURED' }              // access_token IS NULL
  | { readonly code: 'WINDOW_CLOSED' }                        // Meta 131047 (24h window)
  | { readonly code: 'META_API_ERROR' }                       // any other Meta API error
  | { readonly code: 'NETWORK_ERROR' }                        // transport failure / timeout
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };  // persist failed (send already done)

export function sendErrorToHttpStatus(error: WhatsappSendError): 404 | 422 | 502 | 500 {
  switch (error.code) {
    case 'NO_ACTIVE_ACCOUNT':       return 404;
    case 'OUTBOUND_NOT_CONFIGURED': return 422;
    case 'WINDOW_CLOSED':           return 422;
    case 'META_API_ERROR':          return 502;
    case 'NETWORK_ERROR':           return 502;
    case 'DB_ERROR':                return 500;
  }
}
```

| Error code | HTTP | Cause | Body `error` |
|---|---|---|---|
| `NO_ACTIVE_ACCOUNT` | 404 | 0 active accounts, or >1 (misconfig) | `NO_ACTIVE_ACCOUNT` |
| `OUTBOUND_NOT_CONFIGURED` | 422 | active account but `access_token IS NULL` | `OUTBOUND_NOT_CONFIGURED` |
| `WINDOW_CLOSED` | 422 | Meta `131047` (outside 24h window) | `WINDOW_CLOSED` |
| `META_API_ERROR` | 502 | any other Meta API error | `META_API_ERROR` |
| `NETWORK_ERROR` | 502 | transport/timeout/non-JSON | `NETWORK_ERROR` |
| `DB_ERROR` | 500 | persist failed (send already happened) | `INTERNAL_ERROR` |
| (Zod invalid body) | 422 | invalid `{ to, text }` | `VALIDATION_ERROR` |
| (tenant middleware) | 401 / 400 | missing / non-UUID `X-Tenant-Id` | `MISSING_TENANT` / `INVALID_TENANT_ID` |

> **`DB_ERROR` body** follows the contacts convention: surfaced as a generic `INTERNAL_ERROR` (never leak `cause`). `NULL`-token uses `422` per proposal Open Question #2 default; `sdd-spec` confirms.

## Route (`whatsapp-send.route.ts`)

```ts
export const createWhatsappSendRoute = (deps: AppDeps) => {
  const router = new Hono<{ Variables: { tenantId: string } }>();
  router.use('*', createTenantMiddleware(deps.env));

  const bodySchema = z.object({ to: z.string().min(1), text: z.string().min(1) });

  router.post('/', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400); }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.issues }, 422);

    const tenantId = c.get('tenantId');
    const result = await sendWhatsappText(deps, tenantId, parsed.data);
    if (!result.ok) {
      const status = sendErrorToHttpStatus(result.error);
      const errorBody = { error: result.error.code === 'DB_ERROR' ? 'INTERNAL_ERROR' : result.error.code };
      return c.json(errorBody, status);
    }
    return c.json(result.value, 200); // { wamid, status }
  });

  return router;
};
```

Mirrors `contacts.route.ts`: tenant middleware on `*`, JSON-parse guard, Zod safeParse, exported mapper for the union, generic `INTERNAL_ERROR` for `DB_ERROR`.

## Migration DDL + RLS Note (`drizzle/0003_outbound.sql`)

```sql
-- 0003_outbound.sql
-- Outbound send support: per-tenant access token + message direction discriminator.
--
-- WARNING: Re-running `pnpm drizzle-kit generate` will OVERWRITE this file and
-- ERASE any hand-written RLS/grant block. After re-generating, re-append the
-- (none required here) block. This file is intentionally additive-only.
-- (mirrors the warning header in 0002_whatsapp.sql)

-- Additive columns. Both are covered by EXISTING table-level grants to app_rls:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_accounts TO app_rls   (0002)
--   GRANT SELECT, INSERT              ON whatsapp_messages  TO app_rls   (0002)
-- Table-level grants automatically include columns added later → NO new GRANT needed.
-- The app_webhook COLUMN grant on whatsapp_accounts stays (phone_number_id, tenant_id)
-- ONLY → the lookup role intentionally CANNOT read access_token.
-- RLS policies (tenant_isolation) are table-scoped → they automatically cover both
-- new columns. NO policy change needed.

ALTER TABLE "whatsapp_accounts" ADD COLUMN IF NOT EXISTS "access_token" text;

ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "direction" text NOT NULL DEFAULT 'inbound';
```

- **Idempotent**: `ADD COLUMN IF NOT EXISTS` (Postgres 9.6+). Safe to re-run; safe on the dev/test container.
- **No role/policy/grant changes** → `makeIdempotent` is a no-op for this file (no `CREATE ROLE` lines); nothing to extend in `migrate.ts` beyond appending the filename.
- **Append the filename to `MIGRATION_FILES` in BOTH** `src/db/migrate.ts:39` AND `test/_helpers/test-db.ts:60` → `[... '0002_whatsapp.sql', '0003_outbound.sql']`.
- **Drizzle schema TS updated to match** (keeps `$inferSelect` and the Drizzle query builder honest):

```ts
// whatsapp-accounts.schema.ts — add to whatsappAccountsTable + WhatsappAccount type + mapRow
accessToken: text('access_token'),   // NULL = outbound not configured (per-tenant Meta Bearer)

// whatsapp-messages.schema.ts — add to whatsappMessagesTable + WhatsappMessage type + mapRow
direction: text('direction').notNull().default('inbound'),
// COMMENT (schema docblock): for outbound rows, from_phone_e164 holds the RECIPIENT/contact phone
// and received_at carries the SEND timestamp — no rename now (see ADR / design).
```

## File / Module Layout

| File | Action | Description |
|---|---|---|
| `src/meta/meta-client.ts` | **Create** | `MetaClient` type + `SendTextInput`/`SendTextResult`/`MetaSendError` + `createMetaClient(version)` (real `fetch`) + `createFakeMetaClient(response?)` (test double w/ `calls[]`). Never logs the token. |
| `src/whatsapp-send/whatsapp-send.service.ts` | **Create** | `sendWhatsappText(deps, tenantId, { to, text })` → resolve account → call Meta (no tx) → upsert contact + insert outbound row (one tx). `Result<SendOk, WhatsappSendError>`, never throws. Holds `resolveActiveAccount` + `mapMetaError` (or split a repo file). |
| `src/whatsapp-send/whatsapp-send.errors.ts` | **Create** | `WhatsappSendError` union + exported `sendErrorToHttpStatus`. |
| `src/whatsapp-send/whatsapp-send.route.ts` | **Create** | `createWhatsappSendRoute(deps)` — tenant middleware, Zod `{ to, text }`, union → HTTP via the mapper. `POST /whatsapp-send`. |
| `drizzle/0003_outbound.sql` | **Create** | Two additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; warning header; grant/RLS notes (no changes needed). |
| `src/db/schema/whatsapp-accounts.schema.ts` | Modify | Add `accessToken` to table + type + `mapRowToWhatsappAccount`. |
| `src/db/schema/whatsapp-messages.schema.ts` | Modify | Add `direction` to table + type + `mapRowToWhatsappMessage`; outbound semantics docblock. |
| `src/db/migrate.ts` | Modify | Append `'0003_outbound.sql'` to `MIGRATION_FILES`. |
| `src/config/env.ts` | Modify | Add `WHATSAPP_META_API_VERSION: z.string().min(1).default('v21.0')` to `envSchema`. |
| `src/app.ts` | Modify | `AppDeps` gains `meta: MetaClient`; mount `app.route('/whatsapp-send', createWhatsappSendRoute(deps))` inside `if (deps)`. |
| `src/main.ts` | Modify | Compose `const meta = createMetaClient(env.WHATSAPP_META_API_VERSION)`; pass `{ db, env, meta }` to `buildApp`. |
| `src/db/seed-dev.ts` | Modify | Backfill dev `whatsapp_accounts.access_token = 'dev-access-token'` (UPDATE after the existing idempotent INSERT, or add the column to the INSERT). |
| `test/_helpers/test-db.ts` | Modify | Append `'0003_outbound.sql'` to its `MIGRATION_FILES`; extend `seedWhatsappAccount({ ..., accessToken? })` to insert the token; truncate already covers the tables. |
| `test/whatsapp-send/whatsapp-send.service.test.ts` | **Create** | Unit tests over `createFakeMetaClient()` (pure Vitest, no container — see Testing Strategy). |
| `test/whatsapp-send/whatsapp-send.int.test.ts` | **Create** | Integration tests (Testcontainers + fake Meta client). |

`whatsapp.service.ts` (inbound), `contacts.*`, and `whatsapp-messages.*` reads remain UNTOUCHED behaviorally; `upsertContactTx` is REUSED, not modified.

## Testing Strategy (Strict TDD — `pnpm test`, test-first)

The injectable `MetaClient` is the seam that makes the service unit-testable WITHOUT a DB and WITHOUT mocking modules. `sdd-apply` writes tests first.

| Layer | What | Approach |
|---|---|---|
| **Unit — service** | account resolution: 0 active → `NO_ACTIVE_ACCOUNT`; >1 active → `NO_ACTIVE_ACCOUNT`; NULL token → `OUTBOUND_NOT_CONFIGURED`; success → Meta called ONCE with `{ phoneNumberId, accessToken, to, text }`, returns `{ wamid, status }`, persists one outbound row | Pure Vitest. Inject `createFakeMetaClient(...)`. For the account read, either inject a fake `withTenant` (in-memory) OR run the account-resolution unit against a stub — service is structured so the Meta-mapping + ordering are pure. |
| **Unit — `mapMetaError`** | `131047` → `WINDOW_CLOSED`; other `META_API_ERROR` → `META_API_ERROR`; `NETWORK_ERROR` → `NETWORK_ERROR` | Pure function test, no I/O. |
| **Unit — `sendErrorToHttpStatus`** | exhaustive mapping table holds; adding a union member without a case fails TS compile | Pure function test + a type-level exhaustiveness assert. |
| **Unit — `createFakeMetaClient`** | default = `ok({ wamid:'wamid-fake-1', ... })`; override drives any outcome; `calls[]` records the input | Pure Vitest (sanity of the test double itself). |
| **Integration** | full `POST /whatsapp-send` via `buildApp({ db: testDb, env, meta: createFakeMetaClient() })`: configured account + valid body → 200, ONE outbound row (`direction='outbound'`, `from_phone_e164=to`, wamid persisted); NULL token → 422 no row; no account → 404 no row; fake returns Meta `131047` → 422 no row; fake returns `NETWORK_ERROR` → 502 no row; tenant isolation: tenant A's send never resolves tenant B's account under `app_rls`; `received_at` set on the outbound row | Testcontainers (`createTestDb`), `seedWhatsappAccount({ ..., accessToken: 'tok' })`, fake Meta client. The real `createMetaClient` is NEVER constructed in tests. |
| **Regression** | existing inbound/contacts/messages integration tests stay green after `AppDeps` gains `meta` (pass `createFakeMetaClient()` at those call sites) | Existing suites + the new `meta` deps member. |

**Test seams (explicit):**
1. `deps.meta` ← `createFakeMetaClient(response?)` — drives every Meta/transport branch deterministically, no network.
2. `seedWhatsappAccount({ accessToken })` ← extended helper — sets up configured vs. NULL-token vs. no-account scenarios.
3. `mapMetaError` / `sendErrorToHttpStatus` ← pure exported fns — tested in isolation, no HTTP/DB.
4. Two-tx structure ← the account read and the write are separate `withTenant` calls, so an integration test can assert "no row written" on every pre-persist failure branch.

## Env Additions

```ts
// config/env.ts — add to envSchema
WHATSAPP_META_API_VERSION: z.string().min(1).default('v21.0'),  // Meta Graph API version (injected to createMetaClient)
```

## Migration / Rollout

Additive + idempotent: two `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. No new tables, roles, policies, or grants (table-level grants + table-scoped RLS already cover the new columns). Append `'0003_outbound.sql'` to `MIGRATION_FILES` in BOTH `migrate.ts` and `test-db.ts`. `makeIdempotent` needs no change (no role lines in 0003). **Rollback**: `ALTER TABLE whatsapp_accounts DROP COLUMN access_token;` + `ALTER TABLE whatsapp_messages DROP COLUMN direction;` — inbound, contacts, and the messages read are untouched (the `direction` default keeps existing reads valid; the messages DTO does not select `direction`).

## Hard-Constraint Compliance

| Constraint | How the design honors it |
|---|---|
| RLS-only (no `WHERE tenant_id`) | Account read and message write both run inside `withTenant`; `tenant_isolation` policy enforces scope; `LIMIT 2` guards "exactly one", not a tenant filter. |
| Functional DI (no classes/containers/decorators) | `MetaClient` is a TYPE; `createMetaClient`/`createFakeMetaClient` are factory functions; composed once in `main.ts`, threaded via `AppDeps.meta`. |
| `Result<T,E>` in domain (throw only in infra) | Service + repo fns return `Result`; the only throws are inside the write tx (to trigger rollback, caught → `DB_ERROR`) and inside `createMetaClient`'s `fetch` (caught → `NETWORK_ERROR`). Hono `onError` remains the last-resort net. |
| Official Meta Cloud API only | `createMetaClient` hits `graph.facebook.com/{version}/{phoneNumberId}/messages` with a Bearer token — the official Cloud API. No unofficial libraries. |
| Token never logged | `MetaClient` never logs `accessToken`; `DB_ERROR` surfaces a generic `INTERNAL_ERROR`; `raw_payload` stores only the Meta RESPONSE (`{ wamid, status }`), not the credential. |

## Estimated Changed Lines

| Area | Lines | Note |
|---|---|---|
| `meta-client.ts` | ~75 | interface + real + fake |
| `whatsapp-send.service.ts` | ~70 | resolve + send + persist |
| `whatsapp-send.errors.ts` | ~30 | union + mapper |
| `whatsapp-send.route.ts` | ~55 | tenant mw + Zod + mapping |
| `0003_outbound.sql` | ~25 | 2 ALTERs + header/notes |
| schemas (accounts + messages) | ~15 | columns + types + mapRow |
| `migrate.ts` / `test-db.ts` | ~4 | append filename (x2) |
| `env.ts` | ~2 | one var |
| `app.ts` / `main.ts` | ~10 | `meta` dep + mount + compose |
| `seed-dev.ts` | ~4 | token backfill |
| unit test | ~90 | service + pure fns + fake |
| integration test | ~130 | full route + isolation + branches |
| existing-suite deps fix | ~10 | pass `createFakeMetaClient()` at call sites |
| **Total** | **≈ 520 changed lines** (~290 prod + ~230 tests) | matches the proposal forecast |

**400-line budget risk: Medium** (prod ~290 within budget; total pushed over by tests). **Chained PRs recommended: No** (single cohesive primitive; clean 2-PR split exists — PR1 migration+schemas+env+meta-client, PR2 service+route+tests — decided at the Review Workload Guard after `sdd-tasks`).

## Open Questions (defer to `sdd-spec`; design defaults shown)

- [ ] **NULL-token HTTP code** — design defaults to `422` (`OUTBOUND_NOT_CONFIGURED`), consistent with config-validation errors. `sdd-spec` confirms vs. `409`.
- [ ] **>1 active account** — design maps to `NO_ACTIVE_ACCOUNT` (404, treat as misconfiguration) rather than silent first-pick. `sdd-spec` confirms.
- [ ] None blocking. The send-then-persist at-least-once tradeoff is accepted for slice #1 (documented above).
