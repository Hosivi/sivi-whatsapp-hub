# Spec — tenant-ai-config

> Domain: tenant-ai-config (NEW capability — per-tenant AI configuration table)
> Slice: Corte 2 #1 (ai-reply change, merged PR #7)

---

## Purpose

Define the observable behavior for the `tenant_ai_config` table and its
repository: schema, RLS enforcement, and dev seed. This spec describes WHAT must
be true — not how it is implemented.

---

## Requirements

### Requirement: tenant_ai_config — Schema

The migration MUST create a `tenant_ai_config` table with these columns:

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID | PK default `gen_random_uuid()` |
| `tenant_id` | UUID | NOT NULL |
| `vertical` | TEXT | NOT NULL |
| `business_name` | TEXT | NOT NULL |
| `business_info` | JSONB | NOT NULL |
| `enabled` | BOOLEAN | NOT NULL default `true` |
| `system_prompt_override` | TEXT | NULLABLE |
| `created_at` | TIMESTAMPTZ | NOT NULL default `now()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL default `now()` |
| `deleted_at` | TIMESTAMPTZ | NULLABLE (soft-delete) |

No column other than `system_prompt_override` and `deleted_at` may be NULL.

#### Scenario: table exists after migration with correct shape

- GIVEN the migration has been applied
- WHEN the `tenant_ai_config` table is inspected
- THEN all columns from the schema table above exist with their declared types
- AND `enabled` defaults to `true` when not supplied

---

### Requirement: tenant_ai_config — RLS Tenant Isolation

The table MUST have a `tenant_isolation` RLS policy that restricts ALL operations
(SELECT, INSERT, UPDATE, DELETE) to rows where `tenant_id` matches
`app.current_tenant`. The `app_rls` role MUST be granted access via `withTenant`.
No query in application code may use `WHERE tenant_id` — RLS is the sole
enforcement.

#### Scenario: tenant A config not visible to tenant B

- GIVEN a `tenant_ai_config` row exists for tenant A
- WHEN the table is queried as `app_rls` with `SET LOCAL app.current_tenant = '<tenant-B-uuid>'`
- THEN zero rows are returned
- AND the row is visible when queried under tenant A's context

#### Scenario: insert under wrong tenant is blocked

- GIVEN the `app_rls` role is active with tenant B's context
- WHEN an INSERT with `tenant_id = <tenant-A-uuid>` is attempted
- THEN the row is silently excluded from all subsequent queries for tenant B
- AND it is NOT visible under tenant A if tenant A did not create it

---

### Requirement: tenant_ai_config — Dev Seed

The dev seed MUST insert exactly one row for the dev tenant with:
- `vertical = 'tienda_general'`
- `enabled = true`
- `business_name` and `business_info` with sample product/hours data sufficient
  for the `getBusinessInfo` tool to return a non-empty response

The seed MUST be idempotent (re-running does not insert duplicates).

#### Scenario: dev seed produces one tienda_general row

- GIVEN the dev seed has been run
- WHEN `tenant_ai_config` is queried under the dev tenant context
- THEN exactly one row exists with `vertical = 'tienda_general'` and `enabled = true`
- AND `business_info` is a non-empty JSONB object

#### Scenario: seed is idempotent

- GIVEN the dev seed has been run once
- WHEN the dev seed is run a second time
- THEN still exactly one `tienda_general` row exists for the dev tenant

---

### Requirement: tenant_ai_config — Repository Read Contract

The repository MUST expose a function
`getAiConfig(tenantCtx): Promise<Result<TenantAiConfig | null, ConfigError>>`.

- If no row exists for the tenant or the row has `enabled = false` or
  `deleted_at IS NOT NULL`, the function MUST return `ok(null)`.
- If exactly one active row exists, the function MUST return `ok(row)`.
- If more than one active row exists (misconfiguration), the function MUST return
  `err({ kind: 'MULTIPLE_CONFIGS' })` — it MUST NOT silently pick the first.
- The function MUST use `withTenant` — no `WHERE tenant_id` in the query.

#### Scenario: no config row → ok(null)

- GIVEN tenant A has no rows in `tenant_ai_config`
- WHEN `getAiConfig` is called under tenant A's context
- THEN the result is `ok(null)`

#### Scenario: enabled = false → ok(null)

- GIVEN tenant A has one row with `enabled = false`
- WHEN `getAiConfig` is called under tenant A's context
- THEN the result is `ok(null)`

#### Scenario: soft-deleted row is excluded

- GIVEN tenant A has one row with `deleted_at IS NOT NULL`
- WHEN `getAiConfig` is called under tenant A's context
- THEN the result is `ok(null)`

#### Scenario: one active enabled row → ok(row)

- GIVEN tenant A has one row with `enabled = true` and `deleted_at IS NULL`
- WHEN `getAiConfig` is called under tenant A's context
- THEN the result is `ok(<row>)` with all fields populated

#### Scenario: multiple active rows → err MULTIPLE_CONFIGS

- GIVEN tenant A has two rows both with `enabled = true` and `deleted_at IS NULL`
- WHEN `getAiConfig` is called under tenant A's context
- THEN the result is `err({ kind: 'MULTIPLE_CONFIGS' })`

---

## Out of Scope (Non-Requirements for This Slice)

- No-code dashboard for editing tenant AI config.
- Per-tenant rate limits or quota columns.
- Multiple active configs per vertical.
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
