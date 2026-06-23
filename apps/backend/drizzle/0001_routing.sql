-- 0001_routing.sql
-- ContactLead routing: routed_at column + transactional outbox + RLS + grant.
--
-- WARNING: Re-running `pnpm drizzle-kit generate` may OVERWRITE / reorder generated
-- DDL and ERASE the RLS + GRANT block below. After re-generating, re-append the
-- "-- RLS + grant" section. This mirrors the 0000 footgun.
--
-- Every statement is idempotent and safe to re-run:
--   ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS,
--   ENABLE/FORCE RLS are no-ops when already set, GRANT is idempotent.
-- NOTE: this file does NOT create the app_rls role (0000 owns it).

-- 1. routed_at on contacts (additive, nullable).
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "routed_at" timestamptz;

-- 2. Transactional outbox table.
CREATE TABLE IF NOT EXISTS "contact_lead_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "contact_id" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

-- =============================================================================
-- RLS + grant block (hand-written; drizzle-kit cannot emit policies/grants).
-- Re-append this entire section after any drizzle-kit regeneration.
-- =============================================================================

ALTER TABLE "contact_lead_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_lead_outbox" FORCE ROW LEVEL SECURITY;

-- Same NULLIF(current_setting('app.current_tenant', true),'')::uuid pattern as 0000:
-- missing/empty GUC → NULL → default-deny (0 rows).
DROP POLICY IF EXISTS tenant_isolation ON "contact_lead_outbox";
CREATE POLICY tenant_isolation ON "contact_lead_outbox"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- app_rls needs SELECT (future worker drain) + INSERT (this slice). No UPDATE/DELETE yet.
GRANT SELECT, INSERT ON "contact_lead_outbox" TO app_rls;
