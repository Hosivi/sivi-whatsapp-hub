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
- Native review: assess T1 → risk `medium` (`configuration_change` on package.json),
  `review_due` = `slice_budget_reached`; preflight pending after T2 commit.

## Next step

Run the native review preflight on the `a819491..HEAD` slice; then the owner follows
`Docs/runbooks/meta-test-number.md`.
