-- 0004_tenant_ai_config.sql
-- Per-tenant AI configuration table (verticals, business info, prompt override, enable flag).
--
-- WARNING: Re-running `pnpm drizzle-kit generate` will OVERWRITE this file and
-- ERASE the RLS + role block below. After re-generating, re-append everything
-- from the "-- RLS + role block" section to end of file.
-- (mirrors the warning header in 0002_whatsapp.sql)

CREATE TABLE IF NOT EXISTS "tenant_ai_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "vertical" text NOT NULL,
  "business_name" text NOT NULL,
  "business_info" jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "system_prompt_override" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz
);

-- Partial unique index: at most one active config per (tenant, vertical).
-- The index is partial so soft-deleted rows do not block re-creation.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_ai_config_tenant_vertical_uq"
  ON "tenant_ai_config" ("tenant_id", "vertical") WHERE deleted_at IS NULL;

-- =============================================================================
-- RLS + role block (hand-written; drizzle-kit cannot emit policies/roles/grants).
-- Re-append this entire section after any drizzle-kit regeneration.
-- =============================================================================

ALTER TABLE "tenant_ai_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_ai_config" FORCE ROW LEVEL SECURITY;

-- tenant_isolation: app_rls role — scopes all operations to the current tenant GUC.
DROP POLICY IF EXISTS tenant_isolation ON "tenant_ai_config";
CREATE POLICY tenant_isolation ON "tenant_ai_config" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Grants (least privilege):
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_ai_config" TO app_rls;
