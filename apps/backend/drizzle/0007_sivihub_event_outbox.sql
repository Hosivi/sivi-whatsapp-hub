-- 0007_sivihub_event_outbox.sql
-- Hub -> SiviHub event outbox (ADR-0048 corte 1, walking skeleton B2 + B3).
--
-- One row per Hub-side domain event queued for delivery to a tenant's SiviHub
-- events receiver. Enqueued in the SAME transaction as the whatsapp_messages
-- insert it describes (spec item 3: "outbox transaccional"). Drained by an
-- in-process loop (B3) using FOR UPDATE SKIP LOCKED.
--
-- UNIQUE (link_id, event_id) is the outbox's own idempotency guard: re-enqueuing
-- the SAME provider_message_id for the SAME link is a silent no-op.
--
-- WARNING: Re-running `pnpm drizzle-kit generate` OVERWRITES this file and ERASES
-- the hand-written RLS + role + grant block. Re-append it after any regeneration.

CREATE TABLE IF NOT EXISTS "sivihub_event_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "link_id" uuid NOT NULL,
  "event_id" text NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "last_status" text,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "delivered_at" timestamptz
);

ALTER TABLE "sivihub_event_outbox" DROP CONSTRAINT IF EXISTS "sivihub_event_outbox_status_check";
ALTER TABLE "sivihub_event_outbox" ADD CONSTRAINT "sivihub_event_outbox_status_check"
  CHECK (status IN ('pending', 'delivered', 'dead'));

CREATE UNIQUE INDEX IF NOT EXISTS "sivihub_event_outbox_link_event_uq"
  ON "sivihub_event_outbox" ("link_id", "event_id");

-- Drives the drain's batch SELECT (status='pending' AND next_attempt_at <= now()).
CREATE INDEX IF NOT EXISTS "sivihub_event_outbox_pending_idx"
  ON "sivihub_event_outbox" ("next_attempt_at")
  WHERE status = 'pending';

-- =============================================================================
-- RLS + role + grant block (hand-written; drizzle-kit cannot emit these).
-- Re-append this entire section after any drizzle-kit regeneration.
-- =============================================================================

ALTER TABLE "sivihub_event_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sivihub_event_outbox" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "sivihub_event_outbox";
CREATE POLICY tenant_isolation ON "sivihub_event_outbox" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- app_rls: SELECT + INSERT (the enqueue call, inside the withTenant tx it shares with
-- the message write). SELECT is required even for ON CONFLICT ... DO NOTHING -- Postgres
-- needs it to probe the conflict target -- mirroring the existing house pattern on
-- whatsapp_messages and contact_lead_outbox (0001_routing.sql, 0002_whatsapp.sql). No
-- UPDATE -- draining/mutating the queue belongs to the drain loop's own role below.
GRANT SELECT, INSERT ON "sivihub_event_outbox" TO app_rls;

-- app_outbox_drain: low-priv, cross-tenant role for the B3 drain loop ONLY. Mirrors
-- the app_webhook precedent (0002_whatsapp.sql) -- NOSUPERUSER, NOBYPASSRLS, and a
-- single FOR ALL policy scoped to exactly the two tables it needs (this outbox, plus
-- read-only access to sivihub_links to resolve events_url/secret_encrypted). It can
-- NEVER read whatsapp_messages, contacts, or any other domain table.
--
-- The LITERAL 'testpassword' below is the test-path value; makeIdempotent rewrites
-- this whole line in prod with APP_OUTBOX_DRAIN_PASSWORD and ALTERs on re-run.
DO $$ BEGIN
  CREATE ROLE app_outbox_drain LOGIN PASSWORD 'testpassword' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE app_outbox_drain LOGIN PASSWORD 'testpassword';
END $$;
GRANT USAGE ON SCHEMA public TO app_outbox_drain;

DROP POLICY IF EXISTS outbox_drain_access ON "sivihub_event_outbox";
CREATE POLICY outbox_drain_access ON "sivihub_event_outbox" FOR ALL TO app_outbox_drain
  USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON "sivihub_event_outbox" TO app_outbox_drain;

DROP POLICY IF EXISTS outbox_drain_read ON "sivihub_links";
CREATE POLICY outbox_drain_read ON "sivihub_links" FOR SELECT TO app_outbox_drain
  USING (true);
GRANT SELECT ON "sivihub_links" TO app_outbox_drain;
