-- 0008_sivihub_links_auth_read.sql
-- Grants the app_webhook role (created in 0002_whatsapp.sql) cross-tenant,
-- column-scoped read access to sivihub_links (ADR-0048 corte 4, S1 — service
-- authentication for SiviHub-originated requests).
--
-- S1's middleware must resolve WHICH tenant owns a link from a header SiviHub
-- sends, BEFORE any tenant is known (the tenant comes from the link row, never
-- from the request) -- structurally identical to resolveTenant(phoneNumberId)
-- for whatsapp_accounts. Mirrors that existing precedent (the webhook_config_read
-- policy + column-scoped grant) instead of minting a new role for the same job
-- description ("resolve tenant identity from an unauthenticated external request").
--
-- No new role: app_webhook already exists and already has an identical-shaped
-- cross-tenant SELECT policy on whatsapp_accounts. app_outbox_drain (0007) also
-- reads sivihub_links, but that role is scoped to the B3 drain loop's own
-- purpose (draining the outbox) -- reusing it for inbound HTTP request
-- authentication would conflate two unrelated consumers of one credential.
--
-- WARNING: this file has no CREATE TABLE, so `pnpm drizzle-kit generate` should
-- not touch it — but if a future regeneration ever does, re-append this content.

DROP POLICY IF EXISTS webhook_config_read ON "sivihub_links";
CREATE POLICY webhook_config_read ON "sivihub_links" FOR SELECT TO app_webhook
  USING (true);

-- Column-scoped: id (to match the request's link header), tenant_id (what we're
-- resolving), secret_encrypted (to verify the signature) and status (to require
-- 'active' in the WHERE clause -- Postgres column grants apply to WHERE too).
-- No events_url grant -- S1 never needs it.
GRANT SELECT (id, tenant_id, secret_encrypted, status) ON "sivihub_links" TO app_webhook;
