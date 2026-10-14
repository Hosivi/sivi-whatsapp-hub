-- 0010_fixed_replies.sql
-- Fixed-replies stage: until SiviHub's agent takes over (E4), the Hub answers end customers
-- only with fixed replies and never with AI-generated text.
--
-- Numbered 0010 on purpose: 0005-0009 are claimed by branches that are not merged yet.
-- Re-applied on every `migrate` run (src/db/migrate.ts), so every statement is idempotent.
--
-- WARNING: hand-written. Do not regenerate with `pnpm drizzle-kit generate`.

-- tenant_ai_config.enabled now defaults to false, so a new config never turns the AI on by
-- accident. Existing rows are NOT rewritten: the AI_REPLY_ENABLED env switch already keeps
-- AI replies off whatever a row says, and E4 can switch the AI back on without touching rows.
ALTER TABLE "tenant_ai_config" ALTER COLUMN "enabled" SET DEFAULT false;

-- =============================================================================
-- tenant_reply_settings — per-tenant overrides for the fixed replies.
-- No row → the default texts in code apply. enabled = false → no fixed replies at all.
-- Text columns are optional; greeting_text and handoff_text may use the {negocio} and
-- {horario} placeholders. hours_text is the {horario} value itself.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "tenant_reply_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "business_name" text,
  "greeting_text" text,
  "hours_text" text,
  "handoff_text" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz
);

-- Partial unique index: at most one live settings row per tenant.
-- The index is partial so soft-deleted rows do not block re-creation.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_reply_settings_tenant_uq"
  ON "tenant_reply_settings" ("tenant_id") WHERE deleted_at IS NULL;

-- RLS + role block (same conventions as 0004_tenant_ai_config.sql).
ALTER TABLE "tenant_reply_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_reply_settings" FORCE ROW LEVEL SECURITY;

-- tenant_isolation: app_rls role — scopes all operations to the current tenant GUC.
DROP POLICY IF EXISTS tenant_isolation ON "tenant_reply_settings";
CREATE POLICY tenant_isolation ON "tenant_reply_settings" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Grants (least privilege):
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_reply_settings" TO app_rls;
