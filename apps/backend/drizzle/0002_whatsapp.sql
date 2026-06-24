-- 0002_whatsapp.sql
-- WhatsApp accounts + inbound messages schema.
--
-- WARNING: Re-running `pnpm drizzle-kit generate` will OVERWRITE this file and
-- ERASE the RLS + role block below. After re-generating, re-append everything
-- from the "-- RLS + role block" section to end of file.

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

-- =============================================================================
-- RLS + role block (hand-written; drizzle-kit cannot emit policies/roles/grants).
-- Re-append this entire section after any drizzle-kit regeneration.
-- =============================================================================

ALTER TABLE "whatsapp_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_accounts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_messages" FORCE ROW LEVEL SECURITY;
-- NOTE: ENABLE + the role-scoped policies below are what ISOLATE the app roles
-- (app_rls, app_webhook). FORCE only changes behavior for the table OWNER; a
-- superuser still bypasses RLS entirely. FORCE is kept to match the house pattern,
-- NOT because it is what isolates the app roles.

-- app_webhook: low-priv lookup role. CREATE ROLE not idempotent < PG16 -> DO/EXCEPTION
-- guard. The LITERAL 'testpassword' below is the test-path value; makeIdempotent
-- rewrites this whole line in prod with APP_WEBHOOK_PASSWORD and ALTERs on re-run.
DO $$ BEGIN
  CREATE ROLE app_webhook LOGIN PASSWORD 'testpassword' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE app_webhook LOGIN PASSWORD 'testpassword';
END $$;
GRANT USAGE ON SCHEMA public TO app_webhook;

-- whatsapp_accounts: TWO permissive policies, each role-scoped.
--  - app_rls     -> tenant-isolated (same NULLIF pattern as 0000).
--  - app_webhook -> USING(true): reads config rows ACROSS tenants (no tenant GUC here).
DROP POLICY IF EXISTS tenant_isolation ON "whatsapp_accounts";
CREATE POLICY tenant_isolation ON "whatsapp_accounts" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
DROP POLICY IF EXISTS webhook_config_read ON "whatsapp_accounts";
CREATE POLICY webhook_config_read ON "whatsapp_accounts" FOR SELECT TO app_webhook
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
