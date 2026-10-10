-- 0009_ai_reply_usage.sql
-- Per-reply AI usage: which provider/model answered, token totals, latency, LLM and
-- tool calls, fallback attempts. One row per AI reply; 'sent' rows are linked to the
-- outbound whatsapp_messages row (outbound_wamid) and written in the SAME transaction.
-- Never stores prompts, customer text or keys.
--
-- Numbered 0009: 0005–0008 are taken by unmerged branches.
--
-- WARNING: Re-running `pnpm drizzle-kit generate` will OVERWRITE this file and
-- ERASE the RLS + role block below. After re-generating, re-append everything
-- from the "-- RLS + role block" section to end of file.
-- (mirrors the warning header in 0002_whatsapp.sql)

CREATE TABLE IF NOT EXISTS "ai_reply_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "contact_id" uuid REFERENCES "contacts" ("id"),
  "inbound_wamid" text,
  "outbound_wamid" text,
  "status" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "reasoning_tokens" integer,
  "cached_input_tokens" integer,
  "total_tokens" integer NOT NULL,
  "llm_calls" integer NOT NULL,
  "tool_calls" text[] DEFAULT '{}'::text[] NOT NULL,
  "fallback_attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "latency_ms" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz
);

-- CHECK constraints: DROP IF EXISTS + ADD keeps re-runs idempotent (0000 pattern).
ALTER TABLE "ai_reply_usage" DROP CONSTRAINT IF EXISTS "ai_reply_usage_status_check";
ALTER TABLE "ai_reply_usage" ADD CONSTRAINT "ai_reply_usage_status_check"
  CHECK (status IN ('sent', 'send_failed'));
-- A 'sent' row always links its outbound message; a 'send_failed' row never has one.
ALTER TABLE "ai_reply_usage" DROP CONSTRAINT IF EXISTS "ai_reply_usage_outbound_wamid_check";
ALTER TABLE "ai_reply_usage" ADD CONSTRAINT "ai_reply_usage_outbound_wamid_check"
  CHECK ((status = 'sent') = (outbound_wamid IS NOT NULL));

-- Lookup of a message's usage (GET /whatsapp-messages author/usage).
CREATE INDEX IF NOT EXISTS "ai_reply_usage_tenant_outbound_wamid_idx"
  ON "ai_reply_usage" ("tenant_id", "outbound_wamid");

-- =============================================================================
-- RLS + role block (hand-written; drizzle-kit cannot emit policies/roles/grants).
-- Re-append this entire section after any drizzle-kit regeneration.
-- =============================================================================

ALTER TABLE "ai_reply_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_reply_usage" FORCE ROW LEVEL SECURITY;

-- tenant_isolation: app_rls only (same NULLIF pattern as whatsapp_messages in 0002).
-- app_webhook gets NO policy + NO grant.
DROP POLICY IF EXISTS tenant_isolation ON "ai_reply_usage";
CREATE POLICY tenant_isolation ON "ai_reply_usage" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Grants (least privilege, mirrors whatsapp_messages): rows are append-only for the app.
GRANT SELECT, INSERT ON "ai_reply_usage" TO app_rls;
