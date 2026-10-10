# Feature: ai-usage-visibility

Locator: `odd/tasks/ai-usage-visibility.md` · Engram mirror: `odd/ai-usage-visibility/tasks`
Branch: `feat/ai-usage-visibility`, stacked on `worktree-meta-test-number` (HEAD of T5).

## Objective

Make every WhatsApp message attributable and every AI reply measurable: who sent each message
(customer with name and phone, the AI, or a human operator), which provider and model produced
each AI reply, and exactly how many tokens it consumed — visible in the dev console UI, with AI
replies visually distinct.

## Problem / why

- Live test on 2026-10-10 worked end to end, but the Hub cannot say which model answered or how
  many tokens it used: adapters drop Gemini `usageMetadata` / OpenAI `usage`, the chain does not
  report the answering model, and `whatsapp_messages` has no author or usage data.
- The console `HubPanel` does not render the sender's name/phone (the API already returns them)
  and shows AI replies and manual operator sends the same way.
- With a multi-provider chain (Gemini + `openai:gpt-6-luna`) the owner needs per-reply cost
  visibility to choose models.

## Scope

In: normalized token usage from both adapters; answering model + fallback attempts reported by
the chain; accumulation across the tool loop in `runAiReply`; a new RLS table `ai_reply_usage`
persisted atomically with the outbound AI message; `GET /whatsapp-messages` exposing author kind
and AI usage; console UI showing sender, AI vs operator styling, model and tokens; logs
`ai_reply_sent` with model and tokens.

Out: money cost estimation (prices change; tokens only), dashboards/aggregation endpoints,
changes to SiviHub link branches (#14/#15), auth.

## Constraints

- RLS from commit 1 (`tenant_id` + `tenant_isolation`), no explicit `WHERE tenant_id` in app
  queries; UUID PK, `TIMESTAMPTZ`, soft-delete column per conventions.
- New migration number `0009` (0005–0008 are taken by unmerged branches); register it in
  `migrate.ts`.
- Never log or persist prompts, customer text in usage rows, or API keys.
- Backward-compatible API DTO (only additive fields).
- Code/comments English; UI copy Spanish following the console's existing pattern.

## Tasks

- [x] **T1 — Capture and persist AI usage** (route: delegated writer — adapters, chain, types,
  ai-reply service, send persistence, migration, schema, tests; parent added the one-line
  webhook wiring `inboundWamid: wamid` inline).
- [x] **T2 — Expose author and AI usage in `GET /whatsapp-messages`** (route: same backend
  writer as T1, separate work-unit commit).
- [ ] **T3 — Console UI: sender line, AI vs operator bubbles, model + tokens badge, totals**
  (route: delegated web writer after T2's DTO is committed).

## Acceptance criteria

- After a real AI reply, `ai_reply_usage` has one row with provider, model, input/output (and
  reasoning when reported) tokens, latency, llm call count, tool calls and fallback attempts,
  linked to the outbound message wamid.
- `GET /whatsapp-messages` marks each message `customer` / `ai` / `operator` and includes AI usage
  for AI messages; existing consumers keep working.
- Console shows who sent each message and visually distinguishes AI replies with model and tokens.
- Focused tests RED→GREEN; full backend suite, typecheck, lint green; web build/lint green.

## Delivery

Strategy: `ask-on-risk`. Forecast ≈ 900–1,200 authored lines (tests included) → above the
~400 heuristic; branch is stacked so either chain strategy (stacked-to-main or
feature-branch-chain) stays possible. Chain-strategy question deferred to PR time (owner owns
push/PR).

## Progress

- 2026-10-10: feature document created; branch `feat/ai-usage-visibility` created from the T5 commit.

## Verification evidence

- T1+T2 RED: 16 unit tests failing (adapter usage/answeredBy, chain success report, runAiReply
  accounting, DTO author) + integration suites failing on missing module/0009/exports.
  GREEN: focused 138/138 unit + 22/22 integration; full backend 46 files / 548 tests; turbo
  typecheck 2/2; lint 7 baseline warnings, 0 errors.
- Usage fields: Gemini `usageMetadata` (@google/genai 2.10.0 `genai.d.ts:5001-5024`;
  input = prompt + toolUsePrompt, output = candidates + thoughts); OpenAI `usage`
  (prompt/completion/total, reasoning and cached as breakdowns).
- Atomicity: usage row written via a `persistInTx` hook in the same transaction as the outbound
  message row; a failed usage insert rolls back both (test). Fail-soft before 0009 is applied:
  `to_regclass` probe skips the write and logs `ai_reply_usage_not_persisted reason=TABLE_MISSING`.
- Parent spot check after inline webhook wiring: turbo typecheck 2/2; biome clean on the route;
  `test/webhooks` + `ai-reply-usage.int` + `ai-reply.int` → 4 files / 40 tests passed.

## Follow-ups

- Register `0009_ai_reply_usage.sql` in `test/_helpers/test-db.ts` and delete the temporary
  `test/ai/ai-reply-usage-db.helper.ts` (two test files import it).
- Tokens spent before a mid-loop LLM failure or the tool-iteration limit are only logged (status
  CHECK allows `sent`/`send_failed`); consider an `llm_failed` status.
- `inbound_wamid` populated from the webhook path only; other `runAiReply` callers leave it NULL.

## Next step

Apply migration 0009 on the dev DB, then delegate T3 (console UI) to a web writer.
