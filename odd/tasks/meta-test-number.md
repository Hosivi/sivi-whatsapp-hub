# Feature: meta-test-number

Locator: `odd/tasks/meta-test-number.md` · Engram mirror: `odd/meta-test-number/tasks`
Branch: `worktree-meta-test-number` (base `main`@a819491)

## Objective

Let the owner exercise the governed AI reply end-to-end against the REAL Meta
WhatsApp Cloud API using Meta's free test phone number (no Business
Verification, no App Review): phone → Meta → webhook → Hub → Gemini → Graph API → phone.

## Problem / why

- The code path is already real on `main` (webhook verify, HMAC, tenant routing,
  Graph API text send, `ai-reply`), but there is no way to load real Meta
  credentials into `whatsapp_accounts` except the dev seed (`dev-phone-123`) or raw SQL.
- The September `configure:meta` command was never committed and is lost.
- `ENABLE_DEV_ENDPOINTS=true` forces BOTH the fake Meta client and the fake LLM
  (`apps/backend/src/main.ts:44-56`), and nothing documents how to run in real mode.
- There is no runbook for the Meta dashboard + tunnel + env steps.

## Scope

In: an env-only provisioning command for the seeded dev tenant (WhatsApp account
credentials + enable AI), its tests, a `package.json` script, a Spanish runbook.

Out: Embedded Signup, templates, status webhooks, deploy/Dockerfile, client
selection by credential presence, token encryption, SiviHub link (PRs #14/#15).

## Constraints

- Secrets come ONLY from environment variables; never CLI args; never logged or printed.
- Admin connection via `DATABASE_ADMIN_URL` (same as `seed:dev`).
- Follow repo conventions: functional style, `Result` in domain logic, kebab-case files,
  code/comments in English, docs in Spanish.

## Tasks

- [x] **T1 — `configure:meta` command** (route: delegated writer — 2+ non-trivial files:
  command + tests + package script; preparation reading belongs to the writer).
  Upserts the seeded dev tenant's single active `whatsapp_accounts` row with
  `META_PHONE_NUMBER_ID`, `META_DISPLAY_PHONE_NUMBER`, `META_WABA_ID`, `META_ACCESS_TOKEN`,
  and ensures `tenant_ai_config.enabled = true`. Fails clearly when inputs are missing
  or the tenant is not seeded. Never logs the token.
  - Acceptance: focused tests RED→GREEN; full backend suite, typecheck and lint green.
- [x] **T2 — Runbook `Docs/runbooks/meta-test-number.md`** (route: same delegated writer).
  Meta dashboard steps (test number, recipient, System User token, App Secret, webhook
  callback + verify token, `messages` field), tunnel, `.env` template with placeholders,
  migrate → seed:dev → configure:meta → `pnpm dev` (flag OFF), first message, troubleshooting
  by error code (BAD_SIGNATURE, UNKNOWN_PHONE_NUMBER_ID, INVALID_PHONE, AI_DISABLED, WINDOW_CLOSED).
  - Acceptance: structural readback; every env var and script named exists in code.

- [x] **T3 — Preserve Gemini thought signatures across tool-use turns** (route: delegated
  writer — adapter + types + tests; added 2026-10-10 after the live test).
  Evidence: real repro (real DB + real Gemini, non-sending Meta stub) on `gemini-3.5-flash`
  and `gemini-3.5-flash-lite`: the model calls `getBusinessInfo`, the tool runs OK, and the
  next `generateContent` fails with 400 "Function call is missing a thought_signature in
  functionCall parts". Every model available to new keys is Gemini 3.x (`gemini-2.5-flash`
  and `gemini-2.5-flash-lite` return 404 "no longer available to new users"), so no config
  workaround exists. Fix: carry the opaque `thoughtSignature` from response `functionCall`
  parts on the tool-use turn and re-emit it on the matching `functionCall` parts when the
  history is sent back. Anthropic adapter unaffected.
  - Acceptance: focused adapter test RED→GREEN; full backend suite, typecheck and lint green;
    real repro with `gemini-3.5-flash` reaches the send step (`SEND_FAILED` from the stub).

## Delivery

Strategy: `ask-on-risk` (default). Forecast was ≈ 250 authored lines; actual ≈ 1,010
(T1 843 incl. 435 test lines; T2 167-line runbook). It exceeds the ~400 heuristic because
of test coverage and the runbook, not scope; it stays one coherent unit (no artificial split).
Chain strategy is not needed unless the owner wants the PR split.

## Progress

- 2026-10-09: feature document created; worktree `meta-test-number` created from `main`@a819491.
- 2026-10-09: T1 committed as `563680b` (`feat(backend): add configure:meta ...`).
- 2026-10-09: T2 committed in the commit that adds this line (`docs(runbook): ...`).

## Verification evidence

- RED: `vitest run test/db/configure-meta.int.test.ts` → `ERR_MODULE_NOT_FOUND` (module absent).
- GREEN (writer): focused 21/21; full backend suite 41 files / 413 tests passed (395 + 18 new);
  `turbo typecheck --filter @sivihub/whatsapp-hub-backend` 2/2 passed; `biome check .` exit 0.
- Parent spot check: focused `configure-meta.int.test.ts` + `seed-dev.test.ts` → 21/21 passed.
- Parent readback: token only used as SQL parameter and redacted in unexpected errors;
  runbook has 8 sections, placeholders only, no secrets.
- Known caveats: tenant scoping uses the admin connection with explicit `tenant_id`
  (same as `seed-dev.ts`; admin bypasses RLS for bootstrap); re-running `seed:dev` after
  `configure:meta` leaves two active accounts (documented in the runbook); `mapMetaError`
  hides Meta 401/190 as `META_API_ERROR`.
- T3 RED: focused `llm-adapter.unit.test.ts` 2 failed / 13 passed (signature missing on block
  and on re-sent part). GREEN: 15/15; full backend suite 41 files / 416 tests; turbo typecheck
  2/2; lint exit 0 (7 pre-existing warnings). Field: `Part.thoughtSignature` (@google/genai
  2.10.0 `genai.d.ts`). Live parent check (real DB + real Gemini, non-sending Meta stub) with
  `gemini-3.5-flash-lite`: `getBusinessInfo` runs, follow-up call accepted, flow reaches
  `SEND_FAILED` from the stub as expected. `gemini-3.5-flash` returned transient 503s.
- Native review: slice `a819491..0de065b` → risk `medium` (`configuration_change` on
  package.json), `review_due` = `slice_budget_reached`; owner consent **granted**; lens
  `review-reliability` → **approved**; acknowledged, lineage `review-164cd12c98fef37d`
  (authority burned). Reviewed boundary is now `0de065b`.

## Follow-ups (advisory review findings, non-blocking, not in this scope)

- R3-001 (WARNING) `configure-meta.ts:187-196`: if the dev tenant only has an inactive live
  `whatsapp_accounts` row, the script inserts a second row; with the same `phone_number_id`
  it fails as `PHONE_NUMBER_ID_IN_USE` blaming another tenant. Reuse/reactivate that row and test it.
- R3-002 `configure-meta.ts:183-185`: `DEV_TENANT_NOT_SEEDED` is inferred from child rows, not the tenant itself.
- R3-003 `configure-meta.ts:170-181`: `FOR UPDATE` on an empty set does not serialize concurrent inserts.
- R3-004 `configure-meta.int.test.ts:290-303`: idempotency test should assert `updated` and unchanged row id.

## Next step

Owner follows `Docs/runbooks/meta-test-number.md` with the Meta test number. Push/PR are the owner's call.
