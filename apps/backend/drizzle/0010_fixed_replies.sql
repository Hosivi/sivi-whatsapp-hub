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
