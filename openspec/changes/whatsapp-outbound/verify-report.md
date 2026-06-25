# Verify Report — whatsapp-outbound

> Change: whatsapp-outbound
> Date: 2026-06-25
> Verdict: **PASS ✅**

## Validation evidence

- **Tests**: 292 passed (28 files) via `pnpm --filter @sivihub/whatsapp-hub-backend test`.
- **Typecheck**: clean (`tsc -p tsconfig.json --noEmit`), verified independently by the orchestrator.
- **Biome**: clean on changed files.
- **Strict TDD**: every behavioral unit is test-driven. The egress-normalization fix was regression-guard verified — reverting the fix makes the new tests fail, restoring it makes them pass.

## Spec compliance

All requirements across the 4 delta specs are implemented and covered by scenarios:

- **whatsapp-send**: tenant middleware (missing `X-Tenant-Id` → 401), Zod body (422 `VALIDATION_ERROR`), single active account (0 → 404 `NO_ACTIVE_ACCOUNT`, >1 → 422 `MULTIPLE_ACTIVE_ACCOUNTS`), NULL token (422 `OUTBOUND_NOT_CONFIGURED`), non-Peru recipient (422 `INVALID_RECIPIENT`, no send, nothing persisted), Meta invocation, contact upsert + outbound persistence, error mapping (`WINDOW_CLOSED`/422, `META_API_ERROR`/502, `NETWORK_ERROR`/502, `DB_ERROR`/500), RLS isolation, `Result<T,E>` discipline.
- **meta-client**: injectable interface, real `fetch` impl (configurable `WHATSAPP_META_API_VERSION`, defensive parse, error-code mapping, never-throws → `NETWORK_ERROR`), fake test double; the real impl now has mocked-fetch tests (success, error codes, transport throw, non-JSON body, version-in-URL, token non-leakage).
- **whatsapp-accounts**: nullable `access_token` under RLS; `app_webhook` column grant excludes it.
- **whatsapp-messages**: `direction` column; outbound rows set `direction='outbound'`, `contact_id` populated via `upsertContactTx` (NOT NULL), `from_phone_e164` stores the normalized phone (same value sent to Meta).

## Adversarial review (judgment-day)

3 rounds, blind dual judges (opus each). Final: **APPROVED** — zero CRITICAL, zero confirmed real WARNINGs.

Issues found and fixed (would have reached production on the original 277 tests):
- `>1` active account returned 404 instead of the spec-mandated 422 → added `MULTIPLE_ACTIVE_ACCOUNTS` → 422.
- The real Meta client (token-bearing egress) had ZERO tests → mocked-fetch suite added.
- `res.json()` ran before the `res.ok` check → real API errors misclassified as `NETWORK_ERROR`; now checks `res.ok` first and parses defensively.
- A non-Peru E.164 `to` was sent (and charged) to Meta, then failed with 500 persisting nothing → normalize `to` (Peru rule) before the send, 422 `INVALID_RECIPIENT` if invalid.
- The first fix normalized persistence but left the Meta call using the raw `to` (split-brain) → now sends the normalized E.164 to Meta; tests rewritten with a non-canonical input and regression-guard verified.

## Non-blocking follow-ups (documented, not fixed in this slice)

- Outbound `ON CONFLICT (wamid) DO NOTHING` returns `ok` even on a 0-row insert (Meta wamids are unique per send → theoretical).
- `MIGRATION_FILES` array duplicated in `migrate.ts` + `test-db.ts` — extract to a single shared module to avoid drift.
- No `CHECK (direction IN ('inbound','outbound'))` on the new column.
- meta-client 2xx-with-non-JSON-body test gap.
- `text` accepts whitespace-only input; `upsertContactTx` uses `LIMIT 1` without a `deleted_at` ordering (pre-existing shared helper).

## Verdict: PASS ✅
