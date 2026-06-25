# Spec — whatsapp-messages (delta)

> Change: whatsapp-outbound
> Domain: whatsapp-messages (MODIFIED — adds direction discriminator column)
> Artifact store: hybrid
> Marker: MODIFIED
> Base spec: openspec/specs/webhooks/spec.md § "New Capability: whatsapp-messages"

---

## Purpose

This delta adds the `direction` column to `whatsapp_messages` so the same table
stores both inbound and outbound rows. All existing inbound behavior and RLS
policies defined in the base spec remain unchanged.

---

## Delta Requirements

### Requirement: direction Column (ADDED)

The `whatsapp_messages` table MUST gain a `direction TEXT NOT NULL DEFAULT 'inbound'`
column via migration `0003_outbound.sql`.

- All existing rows MUST inherit `direction = 'inbound'` via the column default
  (no explicit backfill required; Postgres applies the default to existing rows
  when a non-nullable column with a default is added via `ALTER TABLE ... ADD COLUMN`).
- Inbound rows written by `POST /webhooks/whatsapp` do NOT need to set `direction`
  explicitly — the default is applied automatically.
- Outbound rows written by `POST /whatsapp-send` MUST set `direction = 'outbound'`
  explicitly.

The updated table shape is:

| Column | Type | Constraint | Delta? |
|--------|------|-----------|--------|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()`, NOT NULL | — |
| `tenant_id` | `UUID` | NOT NULL | — |
| `wamid` | `TEXT` | NOT NULL, UNIQUE | — |
| `phone_number_id` | `TEXT` | NOT NULL | — |
| `contact_id` | `UUID` | NOT NULL (resolved via the shared contact upsert for both directions) | — |
| `from_phone_e164` | `TEXT` | NOT NULL | — |
| `message_type` | `TEXT` | NOT NULL | — |
| `text_body` | `TEXT` | NULLABLE | — |
| `raw_payload` | `JSONB` | NOT NULL | — |
| `direction` | `TEXT` | NOT NULL, DEFAULT `'inbound'` | **ADDED** |
| `received_at` | `TIMESTAMPTZ` | NOT NULL | — |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | — |

> `contact_id` REMAINS NOT NULL for both directions. The outbound send flow reuses
> the same contact upsert the inbound webhook uses (`upsertContactTx`) to resolve
> the recipient contact before inserting the outbound row, so the FK stays intact
> and no constraint is relaxed. `0003_outbound.sql` does NOT alter `contact_id`.
> This keeps a single source of truth for contact resolution and lets the full
> conversation (inbound + outbound) be read by `contact_id`.

#### Scenario: migration adds direction column with default 'inbound'

- GIVEN `0002_whatsapp.sql` has been applied (no `direction` column)
- WHEN `0003_outbound.sql` is applied
- THEN `whatsapp_messages` gains a `direction TEXT NOT NULL DEFAULT 'inbound'` column
- AND all pre-existing inbound rows have `direction = 'inbound'`

#### Scenario: existing inbound INSERT behavior unchanged (direction defaults)

- GIVEN the migration has been applied
- WHEN `POST /webhooks/whatsapp` processes a valid inbound message (no `direction` set explicitly)
- THEN the persisted row has `direction = 'inbound'`
- AND all previously tested inbound scenarios in the base spec still hold

---

### Requirement: Outbound Row Shape

When `POST /whatsapp-send` persists a successful send, the resulting
`whatsapp_messages` row MUST have:

| Field | Value |
|-------|-------|
| `direction` | `'outbound'` |
| `wamid` | the `id` value from Meta's response (`messages[0].id`) |
| `from_phone_e164` | the `to` field from the request body (recipient phone) |
| `phone_number_id` | the `phone_number_id` from the resolved `whatsapp_accounts` row |
| `message_type` | `'text'` |
| `text_body` | the `text` field from the request body |
| `raw_payload` | the Meta API response body (JSONB) |
| `received_at` | timestamp at the time of send |
| `contact_id` | the recipient contact, resolved via the shared contact upsert (NOT NULL) |

#### Scenario: outbound row has correct direction and wamid

- GIVEN `POST /whatsapp-send` succeeds with Meta returning `wamid = 'wamid_out_001'`
- WHEN the row is read back from `whatsapp_messages` under tenant A's context
- THEN `direction = 'outbound'`
- AND `wamid = 'wamid_out_001'`
- AND `from_phone_e164` equals the `to` value from the request body

---

### Requirement: direction Column — Inbound/Outbound Segregation

A query filtered on `direction = 'inbound'` MUST return only inbound rows. A
query filtered on `direction = 'outbound'` MUST return only outbound rows. Both
queries MUST rely on RLS via `withTenant` — no `WHERE tenant_id`.

#### Scenario: filtering by direction returns correct subset

- GIVEN tenant A has one inbound row (`direction = 'inbound'`) and one outbound row (`direction = 'outbound'`)
- WHEN `whatsapp_messages` is queried with `direction = 'inbound'` under tenant A's context
- THEN exactly one row is returned (the inbound row)

- WHEN `whatsapp_messages` is queried with `direction = 'outbound'` under tenant A's context
- THEN exactly one row is returned (the outbound row)

---

### Requirement: Existing Message Tenant Isolation Unchanged

The `tenant_isolation` RLS policy on `whatsapp_messages` MUST continue to
restrict all reads and writes (both `direction = 'inbound'` and `direction = 'outbound'`)
to the current tenant. No `WHERE tenant_id` is permitted.

#### Scenario: outbound row invisible to other tenant

- GIVEN tenant A's outbound row has been persisted
- WHEN `whatsapp_messages` is queried as `app_rls` with tenant B's context
- THEN zero rows are returned (both inbound and outbound)
- AND the row is visible when queried under tenant A's context

---

## Unchanged (from base spec)

All requirements from `openspec/specs/webhooks/spec.md` under "New Capability:
whatsapp-messages" remain in full effect:
- Idempotent inbound persistence (`ON CONFLICT (wamid) DO NOTHING`).
- `tenant_isolation` RLS policy and `app_rls` grants (SELECT, INSERT).
- `app_webhook` exclusion (no grant, no policy).
- Inbound message tenant isolation scenarios.

No existing scenario is removed or weakened by this delta.

---

## Out of Scope (Non-Requirements for This Slice)

- Delivery-status tracking (`direction = 'status'` or equivalent).
- Conversations table or threading by direction.
- Filtering or pagination on the existing `GET /whatsapp-messages` endpoint.
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
