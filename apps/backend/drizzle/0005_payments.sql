-- 0005_payments.sql
-- Payment tables: payments + tenant_payment_config.
--
-- WARNING: Re-running `pnpm drizzle-kit generate` will OVERWRITE this file and
-- ERASE the RLS + role block below. After re-generating, re-append everything
-- from the "-- RLS + role block" section to end of file.
-- (mirrors the warning header in 0004_tenant_ai_config.sql)

CREATE TABLE IF NOT EXISTS "payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "amount" integer NOT NULL,
  "currency" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "external_id" text NOT NULL,
  "reference" text NOT NULL,
  "source_entity_type" text,
  "source_entity_id" uuid,
  "metadata" jsonb NOT NULL,
  "raw_gateway_response" jsonb,
  "paid_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz
);

-- Unique constraint on external_id (gateway reference must be globally unique).
CREATE UNIQUE INDEX IF NOT EXISTS "payments_external_id_uq"
  ON "payments" ("external_id");

CREATE TABLE IF NOT EXISTS "tenant_payment_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "configured" boolean NOT NULL DEFAULT false,
  "public_key" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz
);

-- Partial unique index: at most one active config per (tenant, provider).
-- The index is partial so soft-deleted rows do not block re-creation.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_payment_config_tenant_provider_uq"
  ON "tenant_payment_config" ("tenant_id", "provider") WHERE deleted_at IS NULL;

-- =============================================================================
-- RLS + role block (hand-written; drizzle-kit cannot emit policies/roles/grants).
-- Re-append this entire section after any drizzle-kit regeneration.
-- =============================================================================

-- payments table ---------------------------------------------------------

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;

-- tenant_isolation: app_rls role — scopes all operations to the current tenant GUC.
DROP POLICY IF EXISTS tenant_isolation ON "payments";
CREATE POLICY tenant_isolation ON "payments" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Grants (least privilege):
GRANT SELECT, INSERT, UPDATE, DELETE ON "payments" TO app_rls;

-- tenant_payment_config table ---------------------------------------------

ALTER TABLE "tenant_payment_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_payment_config" FORCE ROW LEVEL SECURITY;

-- tenant_isolation: app_rls role — scopes all operations to the current tenant GUC.
DROP POLICY IF EXISTS tenant_isolation ON "tenant_payment_config";
CREATE POLICY tenant_isolation ON "tenant_payment_config" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Grants (least privilege):
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_payment_config" TO app_rls;
