# Design: WhatsApp Inbound Webhook — Receive + Persist

## Technical Approach

A new `webhooks/` module exposes a public Hono sub-router mounted at `/webhooks/whatsapp` in `buildApp`, parallel to `/contacts`, with NO tenant middleware (tenant is unknown until resolved). `GET` handles the Meta `hub.challenge` handshake. `POST` reads the RAW body first, verifies an HMAC-SHA256 signature over it (global `WHATSAPP_APP_SECRET`), Zod-parses, resolves the tenant from `phone_number_id` via a NEW low-privilege `app_webhook` DB handle, then upserts the contact and persists the message inside a SINGLE `withTenant` transaction (atomicity per routing ADR-3). It ACKs `200` in all non-handshake cases so Meta never retries. Two new RLS tables, one new Postgres role (`app_webhook`), and `0002_whatsapp.sql` carry the persistence layer. `contacts.repository.ts` gains an additive, tx-bound `upsertContactTx` helper (zero CRUD behavior change).

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| **Tenant lookup handle (LOCKED)** | Dedicated `app_webhook` role (NOSUPERUSER, NOBYPASSRLS); 3rd `DbClient` handle `resolveTenant()` from `DATABASE_WEBHOOK_URL` | Reuse superuser `adminSql` on the public path | `adminSql` is bypass-everything and forbidden off migration. A scoped role keeps RLS-from-commit-1 and least privilege on an internet-facing surface. |
| **Credential model = GLOBAL env** | `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN` are GLOBAL env vars; signature verified BEFORE tenant resolution | Per-tenant `app_secret`/`verify_token` columns on `whatsapp_accounts` | The Meta App Secret and verify_token are per-Meta-App, not per-tenant. The Hub is ONE Meta App today, so the key is global; verifying before tenant resolution is coherent. **Forward-compat**: if the Hub later becomes multi-Meta-App / Tech-Provider, move to a per-row secret and verify AFTER resolution (out of scope now). |
| **`whatsapp_accounts` cross-tenant read** | TWO permissive policies: `tenant_isolation TO app_rls`, and `webhook_config_read TO app_webhook` with `USING(true) FOR SELECT` | Single policy; or GRANT with no policy | Permissive policies OR together, but `TO <role>` scopes each. `app_webhook` (no tenant GUC) gets 0 rows under `tenant_isolation`; a role-scoped `USING(true)` lets it read config across tenants WITHOUT widening `app_rls`. |
| **Contact upsert + message insert atomicity** | Run `upsertContactTx(tx, …)` AND the message insert in ONE `withTenant` tx (mirror `routeContact`) | Call `contactsRepository.create()` then insert | `create()` opens its OWN `withTenant` tx — two txs means a crash can commit a half-state. One tx → rollback-all on failure. |
| **`upsertContactTx` extraction (USER APPROVED, additive)** | Extract the SELECT-by-phone + resurrect + insert-with-23505 logic from `create()` into a tx-bound helper that RESOLVES a live row to `ok(existingContact)` (upsert-or-reuse). `create()` wraps it and keeps its "error on live duplicate" semantics. | Inline duplicate logic in the service; or change `create()`'s public behavior | The webhook needs a live contact to RESOLVE to its row, not error. Extracting + reusing keeps ONE source of truth for upsert and ZERO observable CRUD change (existing integration tests still pass). |
| **Idempotency** | `whatsapp_messages.wamid TEXT UNIQUE` + `INSERT … ON CONFLICT (wamid) DO NOTHING` | App-level SELECT-first dedupe | Meta redelivers on any non-200; the UNIQUE constraint is the durable guard. |
| **Ack-fast error mapping** | POST returns `200` for every branch (bad sig, unknown number, normalize fail, DB error — all logged); GET returns `403` only on token mismatch | `401`/`500` on failure | Any non-200 triggers Meta retry storms + duplicates. The service `Result` union is mapped so NOTHING throws to Meta. |

## Data Flow

```
Meta POST /webhooks/whatsapp
  │ c.req.arrayBuffer()  ← RAW bytes FIRST (Hono consumes the stream once)
  ▼
resolveSignature(raw, X-Hub-Signature-256, WHATSAPP_APP_SECRET):
  strip "sha256=" → Buffer.from(hex) for both → length-check BEFORE
  crypto.timingSafeEqual (it THROWS on length mismatch) → never throws out
  │ mismatch / absent ─────────────────────────────────► log + 200
  ▼ JSON.parse(raw) → Zod  ──parse/validate fail──────► log + 200
no value.messages (status event) ─────────────────────► 200 (skip)
  ▼ phone_number_id = entry[0].changes[0].value.metadata.phone_number_id
resolveTenant(phone_number_id)  [app_webhook, NO tenant set; SELECT (phone_number_id, tenant_id)]
  │ unknown ──────────────────────────────────────────► log + 200
  ▼ normalizePhoneE164(wa_id)  ──fail (non-Peru)───────► log + 200
withTenant(tenantId, tx):                       ← ONE tx (atomic)
  ├─ upsertContactTx(tx, { phone, source:'whatsapp' })  → contactId
  └─ INSERT whatsapp_messages (contact_id, …) ON CONFLICT (wamid) DO NOTHING
  ▼ (any throw → tx ROLLBACK → outer catch → DB_ERROR → log)
200
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/webhooks/whatsapp.route.ts` | Create | `createWhatsappWebhookRoute(deps)` — GET handshake + POST (raw body, HMAC, Zod, ack-fast). No middleware. |
| `src/webhooks/whatsapp.service.ts` | Create | `handleInboundMessage(deps, raw, sigHeader)` → verify → resolve tenant → single `withTenant` upsert+insert. Returns `Result`. |
| `src/webhooks/whatsapp.errors.ts` | Create | Error union (all map to 200). |
| `src/db/schema/whatsapp-accounts.schema.ts` | Create | Drizzle schema (config: tenant↔phone_number_id; NO secret columns). |
| `src/db/schema/whatsapp-messages.schema.ts` | Create | Drizzle schema (wamid UNIQUE, raw_payload JSONB, contact_id FK). |
| `drizzle/0002_whatsapp.sql` | Create | 2 tables + FK + indexes + RLS policies + `app_webhook` role/password + column grant + warning header. |
| `src/contacts/contacts.repository.ts` | **Modify (additive)** | Extract `upsertContactTx(tx, input)`; `create()` wraps it (zero behavior change). |
| `src/db/client.ts` | Modify | Add `lookupSql` handle + `resolveTenant()` from `DATABASE_WEBHOOK_URL`; close it. |
| `src/db/migrate.ts` | Modify | Append `'0002_whatsapp.sql'`; extend `makeIdempotent` with an `app_webhook` branch. |
| `src/config/env.ts` | Modify | Add `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `DATABASE_WEBHOOK_URL`, `APP_WEBHOOK_PASSWORD`. |
| `src/app.ts` | Modify | Mount `app.route('/webhooks/whatsapp', createWhatsappWebhookRoute(deps))` inside `if (deps)`. |
| `test/_helpers/test-db.ts` | Modify | Append `0002_whatsapp.sql`; build `app_webhook` connection + `seedWhatsappAccount`; truncate new tables. |
| `test/webhooks/whatsapp.route.int.test.ts` | Create | Integration suite (Testcontainers). |

`contacts.route.ts` and the `contacts-tags-intent` module remain UNTOUCHED.

## Canonical Table DDL + RLS SQL (`0002_whatsapp.sql`)

```sql
-- WARNING: re-running `pnpm drizzle-kit generate` OVERWRITES this file and ERASES
-- the RLS + role block below. After regenerating, re-append this entire section.
-- (mirrors drizzle/0000_contacts.sql:4-6)

CREATE TABLE IF NOT EXISTS "whatsapp_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "phone_number_id" text NOT NULL,
  "display_phone_number" text NOT NULL,
  "waba_id" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_accounts_phone_number_id_uq"
  ON "whatsapp_accounts" ("phone_number_id") WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS "whatsapp_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "wamid" text NOT NULL,
  "phone_number_id" text NOT NULL,
  "contact_id" uuid NOT NULL REFERENCES "contacts" ("id"),
  "from_phone_e164" text NOT NULL,
  "message_type" text NOT NULL,
  "text_body" text,
  "raw_payload" jsonb NOT NULL,
  "received_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_wamid_uq" ON "whatsapp_messages" ("wamid");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_tenant_received_idx"
  ON "whatsapp_messages" ("tenant_id", "received_at");

-- RLS + role block (hand-written; drizzle-kit cannot emit policies/roles/grants) -----

ALTER TABLE "whatsapp_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_accounts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_messages" FORCE ROW LEVEL SECURITY;
-- NOTE: ENABLE + the role-scoped policies below are what ISOLATE the app roles
-- (app_rls, app_webhook). FORCE only changes behavior for the table OWNER; a
-- superuser still bypasses RLS entirely. FORCE is kept to match the house pattern,
-- NOT because it is what isolates the app roles.

-- app_webhook: low-priv lookup role. CREATE ROLE not idempotent < PG16 → DO/EXCEPTION
-- guard. The LITERAL 'testpassword' below is the test-path value; makeIdempotent
-- rewrites this whole line in prod with APP_WEBHOOK_PASSWORD and ALTERs on re-run.
DO $$ BEGIN
  CREATE ROLE app_webhook LOGIN PASSWORD 'testpassword' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE app_webhook LOGIN PASSWORD 'testpassword';
END $$;
GRANT USAGE ON SCHEMA public TO app_webhook;

-- whatsapp_accounts: TWO permissive policies, each role-scoped.
--  - app_rls      → tenant-isolated (same NULLIF pattern as 0000).
--  - app_webhook  → USING(true): reads config rows ACROSS tenants (no tenant GUC here).
DROP POLICY IF EXISTS tenant_isolation ON "whatsapp_accounts";
CREATE POLICY tenant_isolation ON "whatsapp_accounts" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
DROP POLICY IF EXISTS webhook_config_read ON "whatsapp_accounts";
CREATE POLICY webhook_config_read ON "whatsapp_accounts" TO app_webhook FOR SELECT
  USING (true);

-- whatsapp_messages: app_rls only, tenant-isolated. app_webhook gets NO policy + NO grant.
DROP POLICY IF EXISTS tenant_isolation ON "whatsapp_messages";
CREATE POLICY tenant_isolation ON "whatsapp_messages" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Grants (least privilege):
GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_accounts" TO app_rls;
GRANT SELECT, INSERT ON "whatsapp_messages" TO app_rls;
-- app_webhook: COLUMN-scoped SELECT only. resolveTenant MUST select these explicit
-- columns (never SELECT *, which errors under a column grant). No messages/contacts grant.
GRANT SELECT (phone_number_id, tenant_id) ON "whatsapp_accounts" TO app_webhook;
```

Why correct: permissive policies OR, but `TO <role>` scopes each — neither role inherits the other's visibility. `app_webhook` has a COLUMN-scoped SELECT on `whatsapp_accounts` only and zero grant on `whatsapp_messages`/`contacts`, so even with `USING(true)` it cannot touch domain data (permission denied). The `whatsapp_messages.contact_id` FK check runs as `app_rls` inside the same tenant tx, so the referenced `contacts` row is visible under RLS — the FK validates fine.

## `makeIdempotent` extension (prod password determinism — C1)

Extend `makeIdempotent(sql, appRlsPassword, appWebhookPassword = 'app_webhook')` to ALSO rewrite the `app_webhook` line, mirroring the `app_rls` machinery exactly. The 3rd parameter is OPTIONAL (defaults to `'app_webhook'`) so the three existing 2-arg call sites keep compiling under TS strict:

```ts
export function makeIdempotent(
  sql: string,
  appRlsPassword: string,
  appWebhookPassword = 'app_webhook', // optional default — keeps existing 2-arg callers compiling (N1)
): string {
  const rls = appRlsPassword.replace(/'/g, "''");
  const wh = appWebhookPassword.replace(/'/g, "''");
  let out = sql.replace(/CREATE ROLE app_rls[^\n;]+;/, () => `DO $$
BEGIN
  CREATE ROLE app_rls LOGIN PASSWORD '${rls}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE app_rls LOGIN PASSWORD '${rls}';
END
$$;`);
  // The 0002 app_webhook block is already a DO/EXCEPTION with ALTER ... PASSWORD.
  // Rewrite BOTH the CREATE and the ALTER password literals so re-runs re-sync.
  out = out
    .replace(/CREATE ROLE app_webhook LOGIN PASSWORD '[^']*'/,
      `CREATE ROLE app_webhook LOGIN PASSWORD '${wh}'`)
    .replace(/ALTER ROLE app_webhook LOGIN PASSWORD '[^']*'/,
      `ALTER ROLE app_webhook LOGIN PASSWORD '${wh}'`);
  return out;
}
```

`runMigration` sources `const appWebhookPassword = process.env.APP_WEBHOOK_PASSWORD ?? 'app_webhook'` (mirrors `APP_RLS_PASSWORD`) and passes it to `makeIdempotent`. The in-SQL `DO/EXCEPTION` block ALTERs the password on re-run, so prod stays in sync with `DATABASE_WEBHOOK_URL`.

**Testcontainers path (test-db.ts)**: runs raw SQL as superuser, NO `makeIdempotent`. The literal `'testpassword'` baked into the migration MUST equal the password in the test's `app_webhook` connection string:
`postgresql://app_webhook:testpassword@{host}:{port}{db}` — identical to how `app_rls`/`testpassword` already works.

**Existing callers (N1 — no regression).** The three current 2-arg call sites stay valid via the default: `apps/backend/src/db/migrate.ts:81` (prod — additionally updated to pass `appWebhookPassword` sourced from `APP_WEBHOOK_PASSWORD`), `apps/backend/test/db/migrate.int.test.ts:35`, and `apps/backend/test/db/migrate.routing.int.test.ts:44,117`. None of these connect AS `app_webhook`, so the defaulted password is harmless to them. `sdd-tasks`/`sdd-apply` MUST keep all three green and MUST NOT make the 3rd parameter required.

**N2 (naming).** The new low-privilege handle is a PRIVATE `lookupSql` const inside `createDbClient`; only `resolveTenant(phoneNumberId)` is exposed on the `DbClient` type — `lookupSql` is not a `DbClient` member.

## `upsertContactTx` extraction (C3 — additive, zero CRUD regression)

```ts
// contacts.repository.ts — NEW exported tx-bound helper (upsert-or-reuse).
// Live existing row RESOLVES to ok(existingContact) (NOT CONTACT_ALREADY_EXISTS).
export const upsertContactTx = async (
  tx: PostgresJsDatabase,
  tenantId: string,
  input: NewContactInput,
): Promise<Result<Contact, ContactError>> => {
  const normalized = normalizePhoneE164(input.phone);
  if (!normalized.ok) return err({ code: 'INVALID_PHONE' });
  const phoneE164 = normalized.value;
  const rows = await tx.select().from(contactsTable)
    .where(eq(contactsTable.phoneE164, phoneE164)).limit(1);
  const existing = rows[0];
  if (existing && existing.deletedAt === null) return ok(mapRowToContact(existing)); // REUSE live
  if (existing && existing.deletedAt !== null) { /* resurrect UPDATE … RETURNING */ }
  /* else INSERT … RETURNING; catch 23505 → re-SELECT live row → ok (concurrent insert) */
};
```

`create()` is rewritten to call `upsertContactTx` inside its existing `withTenant`, but PRESERVES its public semantics: if the helper returns a row whose phone matched a LIVE pre-existing contact, `create()` returns `err({ code: 'CONTACT_ALREADY_EXISTS' })`. The split:

- **`upsertContactTx`** = upsert-or-reuse (live → reuse). Used by the webhook service.
- **`create()`** = "error on live duplicate" (unchanged public contract). To distinguish "reused live" from "freshly inserted/resurrected", `create()` does its own pre-SELECT of the live row before delegating (or the helper returns a `{ contact, reused: boolean }` discriminator — implementer's choice). Either way, the contacts integration tests keep passing: a live duplicate still yields `CONTACT_ALREADY_EXISTS`.

Non-goal wording amended: "contacts.repository.ts extended ADDITIVELY (new tx-bound `upsertContactTx` helper); zero behavior change to existing CRUD; `contacts.route.ts` untouched."

## Interfaces / Contracts

```ts
// db/client.ts — NEW low-priv handle (lookup ONLY, never domain I/O)
export type DbClient = {
  readonly withTenant: TenantRunner;
  readonly adminSql: postgres.Sql;            // migration/bootstrap only
  /** app_webhook handle: resolves tenant from phone_number_id BEFORE any tenant set.
   *  SELECT (phone_number_id, tenant_id) on whatsapp_accounts. NEVER domain reads/writes. */
  resolveTenant(phoneNumberId: string): Promise<Result<string, WebhookLookupError>>;
  close(): Promise<void>;
};
// resolveTenant runs lookupSql = postgres(env.DATABASE_WEBHOOK_URL) and SELECTs
// EXPLICIT columns (phone_number_id, tenant_id) — NEVER SELECT * (column grant).
// 0 live rows → err(UNKNOWN_PHONE_NUMBER_ID); else ok(tenant_id).

// webhooks/whatsapp.errors.ts — every variant maps to HTTP 200 (logged, never thrown)
export type WhatsappWebhookError =
  | { code: 'BAD_SIGNATURE' }
  | { code: 'UNKNOWN_PHONE_NUMBER_ID' }
  | { code: 'INVALID_PHONE' }
  | { code: 'NO_MESSAGES' }            // status-only event → skip
  | { code: 'DB_ERROR'; cause?: unknown };

// webhooks/whatsapp.service.ts
export const handleInboundMessage: (
  deps: { db: DbClient; env: Env },
  rawBody: ArrayBuffer,
  signatureHeader: string | undefined,
) => Promise<Result<{ wamid: string; contactId: string }, WhatsappWebhookError>>;
```

**GET handshake**: read `hub.mode`, `hub.verify_token`, `hub.challenge`; if `mode==='subscribe'` and `verify_token===env.WHATSAPP_VERIFY_TOKEN` → `c.text(challenge, 200)`; else `c.text('Forbidden', 403)`.

**POST / `resolveSignature` (W5)**: read `c.req.arrayBuffer()` FIRST. If header absent → `BAD_SIGNATURE`. Strip the `sha256=` prefix; compute `crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(rawBuffer).digest()`; build `Buffer.from(hexFromHeader, 'hex')`. LENGTH-CHECK both buffers are equal length BEFORE `crypto.timingSafeEqual` (it THROWS on length mismatch); wrap the whole verify in try/catch so it NEVER throws out of the handler. Mismatch/throw → `BAD_SIGNATURE` → log + 200.

## Env additions

```ts
WHATSAPP_VERIFY_TOKEN: z.string().min(1),   // GLOBAL — Meta App verify_token
WHATSAPP_APP_SECRET:   z.string().min(1),   // GLOBAL — Meta App Secret (HMAC key)
DATABASE_WEBHOOK_URL:  z.string().min(1),   // app_webhook DSN (low-priv lookup)
APP_WEBHOOK_PASSWORD:  z.string().optional(),// prod password sync (mirrors APP_RLS_PASSWORD)
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `resolveSignature` valid/invalid/length-guard (no throw); GET handshake branches; Zod parse of a real Meta payload; status-only skip | Pure fns / `app.fetch()` with crafted `X-Hub-Signature-256` |
| Integration | `app_webhook` reads `whatsapp_accounts(phone_number_id, tenant_id)` cross-tenant; `app_webhook` CANNOT read `whatsapp_messages`/`contacts` (permission denied); `app_rls` CANNOT read other tenants' accounts; full POST → contact+message persisted with `contact_id`; duplicate `wamid` → single row; unknown number → 200 no rows; non-Peru `wa_id` → 200 no rows; tx rollback on forced insert failure; `create()` still returns `CONTACT_ALREADY_EXISTS` on live duplicate (no regression) | Testcontainers; `seedWhatsappAccount` + admin |

## Migration / Rollout

Additive + idempotent: `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `DO/EXCEPTION` role guard with `ALTER … PASSWORD` re-sync, column-scoped GRANT. Append `0002_whatsapp.sql` to `MIGRATION_FILES` in BOTH `migrate.ts` and `test-db.ts`. Prod password via `APP_WEBHOOK_PASSWORD` → `makeIdempotent`; test path uses the literal `'testpassword'` matching the `app_webhook` DSN. Rollback: drop both tables + `app_webhook` role; `contacts` untouched.

## Re-budgeted changed-lines estimate

| Area | Lines | Note |
|---|---|---|
| env | ~8 | +4 vars |
| client (`resolveTenant`) | ~30 | |
| app mount | ~4 | |
| wa-accounts schema | ~28 | no secret cols |
| wa-messages schema | ~40 | +contact_id FK, message_type, from_phone_e164, text_body |
| `0002_whatsapp.sql` | ~90 | 2 tables + FK + 2-policy RLS + role + column grant |
| migrate (`makeIdempotent` ext) | ~12 | +app_webhook branch |
| **contacts.repository (extraction)** | **~45** | NEW — `upsertContactTx` + `create()` rewrap |
| route | ~95 | |
| service | ~80 | |
| errors | ~16 | |
| test-db | ~30 | |
| integration test | ~175 | +extraction-regression + FK tests |
| **Total** | **≈ 653 changed lines** (~415 prod + ~238 tests) | |

**400-line budget risk: High. Chained PRs recommended: Yes.** Suggested split: PR1 = migration + schemas + env + client handle + app mount + `makeIdempotent` ext + `upsertContactTx` extraction (~257 prod foundation, independently shippable, contacts tests guard the extraction); PR2 = route + service + errors + webhook tests (~396). Final call at the Review Workload Guard after `sdd-tasks`.

## Corrections Applied (gate findings → resolution)

| Finding | Resolution |
|---|---|
| **C1** app_webhook password determinism | `makeIdempotent` extended with an `app_webhook` branch (rewrites CREATE + ALTER password lines); prod sources `APP_WEBHOOK_PASSWORD`; in-SQL `DO/EXCEPTION` ALTERs on re-run; test path uses literal `'testpassword'` equal to the `app_webhook` DSN. |
| **C2** contact_id | Settled to `contact_id UUID NOT NULL REFERENCES contacts(id)`; FK added; FK check runs as `app_rls` in the same tenant tx (row visible under RLS). Canonical — spec to be corrected (was NULLABLE). |
| **C3** Extract upsertContactTx | Added `contacts.repository.ts` to File Changes; tx-bound `upsertContactTx` = upsert-or-reuse (live → `ok(existing)`); `create()` wraps it preserving `CONTACT_ALREADY_EXISTS` on live duplicate; zero CRUD regression; non-goal wording amended; re-budgeted (+45). |
| **C4** Credential model = GLOBAL env | Confirmed `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN` GLOBAL; NO `app_secret`/`verify_token` columns on `whatsapp_accounts`; signature verified before tenant resolution; forward-compat note added. Canonical — spec to be corrected. |
| **W1** grant scope | `GRANT SELECT (phone_number_id, tenant_id)` (column-scoped); `resolveTenant` selects those explicit columns, never `SELECT *`. |
| **W2** FORCE comment | Corrected: ENABLE + role-scoped policies isolate the app roles; FORCE only affects the OWNER, superuser still bypasses; FORCE kept to match house pattern. |
| **W5** HMAC | `resolveSignature` strips `sha256=`, length-checks before `timingSafeEqual`, wrapped so it never throws out of the handler (ack-fast 200). |
| **W6** direction column | Dropped `direction` (YAGNI for receive-only); `whatsapp_messages` column set matches spec scenarios (`wamid`, `phone_number_id`, `from_phone_e164`, `message_type`, `raw_payload`, `received_at`). |
| **S1/S2** column set & FK alignment | Canonical `whatsapp_messages` shape defined (incl. `text_body`); spec to be aligned to this table and the NOT NULL `contact_id` FK. |

## Open Questions

- [ ] None blocking. `is_active` on `whatsapp_accounts` is included (cheap forward-compat for deactivating a number without soft-delete); drop if the team prefers strict YAGNI.
