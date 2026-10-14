# Feature: fixed-replies

Locator: `odd/tasks/fixed-replies.md` · Engram mirror: `odd/fixed-replies/tasks`
Branch: `feat/fixed-replies` (base `origin/main`@90334ab)
Parent: SiviHubSoftware `odd/tasks/modulo-b2b-e1.md`, task T11 (owner decisions D13 and D22,
ADR-0067 «D13: hasta E4, el Hub contesta solo con respuestas fijas»).

## Objective

Until SiviHub's own agent is switched on (stage E4), the Hub answers end customers only with
fixed replies (greeting, business hours, handoff to an advisor) and never with AI-generated text.

## Problem / why

- The AI auto-reply fires for every inbound text (`apps/backend/src/webhooks/whatsapp.route.ts:79-84`).
  The only gate is `tenant_ai_config.enabled`, and that column defaults to `true`
  (`drizzle/0004_tenant_ai_config.sql:15`). On top of that, `seed-dev.ts` and `configure-meta.ts`
  both switch it on.
- No fixed replies exist: no greeting, no hours, no handoff.
- The inbound insert cannot tell a new message from a duplicate `wamid`. Any auto-reply would
  therefore repeat when Meta retries a webhook.

## Scope

In:
- A process-wide kill switch, `AI_REPLY_ENABLED`. It is on only for the literal `"true"` and off by
  default, and it is checked before `runAiReply`.
- The default of `tenant_ai_config.enabled` flips to `false` (migration 0010 plus the schema). The
  seed and `configure:meta` stop switching the AI on.
- A signal on the inbound result that tells a new message from a duplicate. No auto-reply runs for
  a duplicate `wamid`.
- A fixed-replies module with a pure selector and a service. Default texts live in code, and a new
  RLS table `tenant_reply_settings` can override them per tenant.
- Spec updates: the scenario in the OpenSpec `tenant-ai-config` spec that requires `enabled`
  default true, and a new `fixed-replies` spec.

Out:
- An API or UI to edit the texts. In E1 they are edited through SQL or the seed only.
- A structured weekly schedule and out-of-hours replies.
- Going silent or tagging the contact after a handoff.
- The `author` value of the SiviHub event contract, because PR #15 is unmerged.
- WhatsApp templates (SiviHub E1 T10).

## Assumptions (the owner did not decide these; revisit them in the PR)

- **A1:** existing `tenant_ai_config` rows are not rewritten. The env switch already guarantees D13
  whatever the data says, and E4 can switch the AI back on without touching rows.
- **A2 — triggers:**
  - Greeting: the first inbound text from a contact in the last 24 h. It carries a numbered menu:
    1 for hours, 2 for an advisor.
  - Hours: `1`, or an hours keyword (horario, hora, abren, atienden, …).
  - Handoff: `2`, or an advisor keyword (asesor, persona, humano, …).
  - Anything else gets no reply, so the Hub never answers every message.
  - Matching ignores case and accents.
- **A3 — default customer-facing texts** (neutral Peruvian Spanish, tuteo). `{negocio}` is the
  business name and `{horario}` the hours text:
  - Greeting: «¡Hola! Gracias por escribir a {negocio}. Responde 1 para ver nuestro horario o 2
    para hablar con un asesor.» Without a business name: «¡Hola! Gracias por escribirnos. …».
  - Hours: «Nuestro horario de atención es: {horario}.» Without an hours text it falls back to the
    handoff reply.
  - Handoff: «Listo, un asesor te responderá por este chat en cuanto esté disponible.»
- **A4:** the migration is numbered 0010, because 0005–0009 are claimed by unmerged branches
  (`feat/payment-link-core`, PRs #14, #15 and #19).

## Constraints

- Follow the repo conventions in `CLAUDE.md`:
  - RLS on every new table, and never `WHERE tenant_id`.
  - `Result` in domain code, never throwing.
  - kebab-case files.
  - Code, comments, commits and PR text in English; customer-facing copy in Spanish.
- Test-first with vitest. Integration tests use Testcontainers and need Docker.
- Migrations are an explicit list, kept in `src/db/migrate.ts` and in `test/_helpers/test-db.ts`
  (including its TRUNCATE list).
- No push, no PR and no merge without the owner.

## Tasks

- [x] **T1 — AI off by default and the dedupe signal.**
  - Covers the kill switch, the 0010 default flip, the seed and `configure:meta`, the `isNew` flag
    from the inbound handler, and the spec scenario.
  - Route: delegated writer, because of 2+ non-trivial files. The parent added one fixture line
    inline in `src/http/tenant.middleware.test.ts`: it builds a full `Env` literal, and it is the
    only test file under `src/`, which is all that typecheck covers.
  - What changed:
    - `dispatchAutoReply` in `whatsapp.route.ts` is the single seam. It runs only for a new message
      that has text.
    - With the switch on, it fires `runAiReply` as before. With the switch off, it logs
      `ai_reply_skipped reason=AI_REPLY_DISABLED`, and T2 adds the fixed reply there.
    - Migration `0010_fixed_replies.sql` only changes the default and rewrites no rows.
    - `configure:meta` now runs `ensureAiConfigExists`: it inserts a missing row with
      `enabled = false` and leaves an existing row untouched.
  - RED: 14 failing tests in the 5 changed files. GREEN: 68/68.
  - Checks:
    - Full backend suite: 42 files, 424/424.
    - `pnpm lint`: green. The 7 warnings were already there, in files this change does not touch.
    - `pnpm typecheck`: green after the parent's fixture line.
    - `git diff --check`: clean.
    - Parent spot check: 42/42.
  - In a fresh worktree, run `pnpm --filter @sivihub/contracts build` before the backend suite.
  - Negative assertions wait a fixed 500 ms, because the repo has no helper that waits for
    fire-and-forget work.
- [x] **T2 — Fixed replies.**
  - Covers the selector, the `tenant_reply_settings` table (in the same 0010 migration), the
    service, the webhook wiring, the new spec, and the dev seed row.
  - Route: delegated writer, the same thread as T1.
  - What changed:
    - `src/fixed-replies/`: the pure `fixed-reply.ts` (`normalize`, `selectFixedReply`,
      `renderFixedReply`), `fixed-reply.service.ts` (`runFixedReply`, which returns `Result` and
      never throws) and `reply-settings.repository.ts` (reads under RLS).
    - Migration 0010 adds `tenant_reply_settings`: a partial unique index on the live row, RLS
      enabled and forced, the `tenant_isolation` policy and the grants.
    - Exactly one path runs per message: AI when the switch is on, fixed replies when it is off.
    - Each message gets exactly one log line: `fixed_reply_sent`, `fixed_reply_skipped` or
      `fixed_reply_failed`.
    - The runbook `Docs/runbooks/meta-test-number.md` describes fixed replies as the default and
      how to switch the AI on for a test (`AI_REPLY_ENABLED=true` plus `tenant_ai_config` by SQL).
      Its voseo was neutralized: a scan finds 0 hits.
  - Decisions the writer took (accepted by the parent):
    - Fixed replies also respect the 24 h window (`WINDOW_CLOSED`), because Meta rejects free text
      outside it and can re-deliver old messages.
    - "First in 24 h" counts only inbound text messages.
    - `hours_text` is the `{horario}` value, not an override. Only the greeting and the handoff
      can be overridden.
    - An override that needs a value the tenant has not set falls back to the default.
  - RED:
    - The three new test files failed with `ERR_MODULE_NOT_FOUND`.
    - The seed test failed with `relation "tenant_reply_settings" does not exist`.
    - The switch-off webhook test expected 1 send and got 0.
  - GREEN: 5 files, 75/75.
  - Checks:
    - Full backend suite: 45 files, 462/462. The parent re-ran it after the writer's formatting
      pass and got the same result.
    - `pnpm lint` and `pnpm typecheck`: green.
    - `git diff --check`: clean.
  - Follow-up: the dev greeting reads «Tienda Dev (seed)», because the seed reuses
    `DEV_AI_BUSINESS_NAME`. Local databases need `migrate` before `seed:dev`.

## Acceptance criteria

- With `AI_REPLY_ENABLED` unset, the fake LLM gets 0 calls even when `tenant_ai_config.enabled = true`.
- A first message gets the greeting, and a second message within 24 h does not.
- `1` or an hours keyword gets the hours reply; `2` or an advisor keyword gets the handoff reply.
- Any other text gets no reply.
- A duplicate `wamid` gets no reply.
- Every reply is sent through `sendWhatsappText` and stored as an outbound message.
- The new table has RLS (with a cross-tenant isolation test).

## Checks

`pnpm --filter @sivihub/whatsapp-hub-backend test`, `pnpm lint`, `pnpm typecheck`.

## Progress

- 2026-10-14: explored and planned (parent session, from SiviHubSoftware T11).
- 2026-10-14: T1 committed as `3a766c9`. Native assess: medium risk, `review_due: false`
  (`under_budget`), so no native review was opened.
- 2026-10-14: T2 implemented and verified (this commit).

## Next step

The owner decides on push and PR, and reviews assumptions A1–A4 in the PR. These Hub draft PRs
overlap with this work in `whatsapp.route.ts`, `whatsapp.service.ts` and `migrate.ts`:

- #14 already adds `wasInserted`, the same idea as `isNew`.
- #15 makes `SendInput.author` required; fixed replies will need an author value.
- #19 adds migration 0009.

Whichever lands second has to reconcile.
