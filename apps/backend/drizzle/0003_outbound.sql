-- 0003_outbound.sql
-- Outbound send support: per-tenant access token + message direction discriminator.
--
-- WARNING: Re-running `pnpm drizzle-kit generate` will OVERWRITE this file and
-- ERASE any hand-written RLS/grant block. After re-generating, re-append the
-- (none required here) block. This file is intentionally additive-only.
-- (mirrors the warning header in 0002_whatsapp.sql)

-- Additive columns. Both are covered by EXISTING table-level grants to app_rls:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_accounts TO app_rls   (0002)
--   GRANT SELECT, INSERT              ON whatsapp_messages  TO app_rls   (0002)
-- Table-level grants automatically include columns added later → NO new GRANT needed.
-- The app_webhook COLUMN grant on whatsapp_accounts stays (phone_number_id, tenant_id)
-- ONLY → the lookup role intentionally CANNOT read access_token.
-- RLS policies (tenant_isolation) are table-scoped → they automatically cover both
-- new columns. NO policy change needed.

ALTER TABLE "whatsapp_accounts" ADD COLUMN IF NOT EXISTS "access_token" text;

ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "direction" text NOT NULL DEFAULT 'inbound';
