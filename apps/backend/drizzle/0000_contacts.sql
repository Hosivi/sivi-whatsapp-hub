-- 0000_contacts.sql
-- Base DDL generated from Drizzle schema (contacts.schema.ts).
--
-- WARNING: Re-running `pnpm drizzle-kit generate` will OVERWRITE this file and
-- ERASE the RLS + role block below. After re-generating, re-append everything
-- from the "-- RLS + role" section to end of file.

CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"full_name" text,
	"source" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"intent" text,
	"intent_confidence" NUMERIC(5,4),
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"deleted_at" timestamptz
);

ALTER TABLE "contacts" ADD CONSTRAINT "intent_confidence_range"
  CHECK (intent_confidence >= 0 AND intent_confidence <= 1);

-- Partial unique index: live contacts only (soft-deleted rows excluded).
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_tenant_phone_uq"
  ON "contacts" ("tenant_id", "phone_e164")
  WHERE deleted_at IS NULL;

-- Index for tenant-scoped list queries ordered by created_at DESC.
CREATE INDEX IF NOT EXISTS "contacts_tenant_created_idx"
  ON "contacts" ("tenant_id", "created_at");

-- =============================================================================
-- RLS + role block (hand-appended; drizzle-kit cannot emit policies or roles).
-- If you re-run `pnpm drizzle-kit generate`, re-append this entire section.
-- =============================================================================

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

-- current_setting('app.current_tenant', true): the second arg (missing_ok=true)
-- returns NULL instead of raising an error when the GUC is not yet set.
-- NULL = '' cannot equal any tenant_id UUID, so the policy returns 0 rows (default-deny).
-- NULLIF converts '' (empty string) to NULL, preventing a cast error on ''::uuid.
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Non-superuser application role.
-- IMPORTANT: when running via createTestDb(), use a LITERAL password string.
-- Do NOT use psql variable syntax (:'app_rls_pw') — the postgres.js driver
-- does not support psql metacommands and will fail silently or error.
CREATE ROLE app_rls LOGIN PASSWORD 'testpassword' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_rls;
