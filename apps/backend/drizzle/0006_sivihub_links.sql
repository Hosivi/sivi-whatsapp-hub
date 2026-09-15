-- 0006_sivihub_links.sql
-- SiviHub Link (Hub -> SiviHub events webhook) -- ADR-0048 corte 1, walking skeleton B1.
--
-- One row per tenant's active link to a SiviHub events receiver. The events URL and
-- HMAC secret travel operator-to-operator (spec: "Vinculacion en este corte") via the
-- `sivihub:link` CLI command -- never through a public endpoint.
--
-- "At most one active link per tenant" (spec item 1) is enforced by a PARTIAL UNIQUE
-- INDEX on (tenant_id) WHERE status = 'active', which doubles as the ON CONFLICT
-- target for the CLI's store-or-replace upsert (see sivihub-links.repository.ts).
--
-- WARNING: Re-running `pnpm drizzle-kit generate` OVERWRITES this file and ERASES the
-- hand-written RLS + grant block. After any re-generation, re-append it (mirrors the
-- footgun documented at the top of 0000_contacts.sql / 0002_whatsapp.sql).

CREATE TABLE IF NOT EXISTS "sivihub_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "events_url" text NOT NULL,
  "secret_encrypted" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE "sivihub_links" DROP CONSTRAINT IF EXISTS "sivihub_links_status_check";
ALTER TABLE "sivihub_links" ADD CONSTRAINT "sivihub_links_status_check"
  CHECK (status IN ('active', 'revoked'));

-- "At most one active link per tenant" AND the ON CONFLICT target for the CLI upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "sivihub_links_tenant_active_uq"
  ON "sivihub_links" ("tenant_id") WHERE status = 'active';

-- =============================================================================
-- RLS + grant block (hand-written; drizzle-kit cannot emit policies/grants).
-- Re-append this entire section after any drizzle-kit regeneration.
-- =============================================================================

ALTER TABLE "sivihub_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sivihub_links" FORCE ROW LEVEL SECURITY;

-- Same NULLIF(current_setting('app.current_tenant', true), '')::uuid pattern as 0000:
-- missing/empty GUC -> NULL -> default-deny (0 rows).
DROP POLICY IF EXISTS tenant_isolation ON "sivihub_links";
CREATE POLICY tenant_isolation ON "sivihub_links" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- app_rls: SELECT (enqueue reads the active link) + INSERT/UPDATE (the sivihub:link
-- CLI's store-or-replace upsert). No DELETE this corte -- unlinking is a future status
-- transition, not a row deletion.
GRANT SELECT, INSERT, UPDATE ON "sivihub_links" TO app_rls;
