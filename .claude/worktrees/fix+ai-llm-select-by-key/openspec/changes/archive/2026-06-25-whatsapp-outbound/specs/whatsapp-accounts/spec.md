# Spec — whatsapp-accounts (delta)

> Change: whatsapp-outbound
> Domain: whatsapp-accounts (MODIFIED — adds nullable access_token column)
> Artifact store: hybrid
> Marker: MODIFIED
> Base spec: openspec/specs/webhooks/spec.md § "New Capability: whatsapp-accounts"

---

## Purpose

This delta adds the `access_token` column to `whatsapp_accounts` to support
per-tenant outbound send credentials. All existing inbound behavior and RLS
policies defined in the base spec remain unchanged.

---

## Delta Requirements

### Requirement: access_token Column (ADDED)

The `whatsapp_accounts` table MUST gain a nullable `access_token TEXT` column
via migration `0003_outbound.sql`. The column MUST default to `NULL` (not
configured). The existing `tenant_isolation` RLS policy on `app_rls` MUST
already cover this column by table-level SELECT, INSERT, UPDATE, DELETE grants —
no additional policy is needed.

The complete updated table shape is:

| Column | Type | Constraint | Delta? |
|--------|------|-----------|--------|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()`, NOT NULL | — |
| `tenant_id` | `UUID` | NOT NULL | — |
| `phone_number_id` | `TEXT` | NOT NULL, UNIQUE (partial: `WHERE deleted_at IS NULL`) | — |
| `display_phone_number` | `TEXT` | NOT NULL | — |
| `waba_id` | `TEXT` | NOT NULL | — |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | — |
| `access_token` | `TEXT` | NULLABLE | **ADDED** |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | NULLABLE (soft-delete) | — |

The `access_token` value represents a Meta System User permanent Bearer token
(non-expiring but revocable). It MUST NOT appear in any log line, API response,
or trace at any level.

#### Scenario: migration adds access_token column as nullable

- GIVEN `0002_whatsapp.sql` has been applied (no `access_token` column)
- WHEN `0003_outbound.sql` is applied
- THEN `whatsapp_accounts` gains an `access_token TEXT` column with no NOT NULL constraint
- AND existing rows have `access_token = NULL` (no backfill for live data)

#### Scenario: existing app_rls grants cover access_token without change

- GIVEN the migration has applied the new column
- WHEN querying `whatsapp_accounts` as `app_rls` under a valid tenant context
- THEN `access_token` is readable and writable without any additional grant
- AND `app_webhook` cannot read `access_token` (column-scoped grant does NOT include it)

---

### Requirement: app_webhook Role Exclusion

The `app_webhook` role's existing column-scoped grant
(`SELECT (phone_number_id, tenant_id)`) MUST NOT be expanded to include
`access_token`. The token MUST remain inaccessible to the low-privilege webhook
lookup role.

#### Scenario: app_webhook cannot read access_token

- GIVEN the migration has run
- WHEN connecting as `app_webhook` and executing
  `SELECT access_token FROM whatsapp_accounts`
- THEN the query is denied (column permission error)

---

### Requirement: Dev Seed Backfill

`seed-dev.ts` MUST be updated to insert (or upsert) the dev `whatsapp_accounts`
row with `access_token = 'dev-access-token'` (a placeholder, not a real Meta
token). This allows the dev path to exercise the full outbound flow end-to-end
against the fake Meta client without requiring a real token.

Repeated runs MUST be idempotent — no duplicate rows, no error.

#### Scenario: dev seed sets access_token placeholder

- GIVEN the dev seed has been run
- WHEN querying the dev `whatsapp_accounts` row
- THEN `access_token = 'dev-access-token'`
- AND `deleted_at` is NULL (row is live)

#### Scenario: repeated seed runs remain idempotent

- GIVEN the dev seed has been run once
- WHEN `seed-dev.ts` is executed again
- THEN still exactly one row exists with `access_token = 'dev-access-token'`
- AND the script exits without error

---

## Unchanged (from base spec)

All requirements from `openspec/specs/webhooks/spec.md` under "New Capability:
whatsapp-accounts" remain in full effect:
- Table shape (all pre-existing columns).
- `tenant_isolation` and `webhook_config_read` RLS policies.
- `app_rls` table-level grants.
- `app_webhook` column-scoped grant (`phone_number_id`, `tenant_id` only).
- Tenant resolution via `phone_number_id` behavior and scenarios.
- Low-privilege lookup role requirements.

No existing scenario is removed or weakened by this delta.

---

## Out of Scope (Non-Requirements for This Slice)

- Token encryption at rest (pgcrypto, secrets manager).
- Token rotation or revocation detection.
- Multiple `access_token` values per tenant account.
- Any column other than `access_token` added to `whatsapp_accounts`.
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
