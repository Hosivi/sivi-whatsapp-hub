# Proposal: Contact Tags + Manual Intent — Focused Endpoints

## Intent

Corte 1 needs an operator to **label** a WhatsApp contact (tags) and to **manually set/clear an intent** on that contact — the two "manual classification" capabilities listed in the roadmap. The `contacts` table already carries `tags TEXT[]`, `intent TEXT` (free-text, no enum), and `intent_confidence NUMERIC(5,4)`, and `repo.update` already writes them. What is MISSING is an intention-revealing, validated API: today only a general-purpose `PATCH /:id` accepts these fields with no tag dedup/normalization, no per-tag/length limits, and no explicit set/clear semantics. This slice ships THREE focused endpoints with thin services + own error unions, so tag and intent management are cohesive, validated, and testable — entirely Hub-internal (no migration, no `ContactLead` change).

## Scope

### In Scope
- `PUT /contacts/:id/tags` — replace the full tag set (idempotent); body `{ tags: string[] }`.
- `DELETE /contacts/:id/tags/:tag` — remove one tag by value (idempotent no-op if absent).
- `PUT /contacts/:id/intent` — set or clear intent; body `{ intent: string | null, intentConfidence?: number | null }`.
- Thin services `contacts.tags.ts` / `contacts.intent.ts` over `repo.update`, each with its own error union file + a Result→HTTP mapper in `contacts.route.ts`.
- Integration tests (Testcontainers as `app_rls`) for both services + HTTP layer; minor `seedTenant` extension (`tags?`, `intent?`).

### Out of Scope (Non-goals)
- Intent **enum migration** or DB CHECK on `intent` (stays free-text; enum is a future change).
- WhatsApp/AI **auto-tagging** or auto-intent inference (Corte 2+).
- Bulk tag operations, tag analytics/counts, tag rename/merge.
- Any UI, any `ContactLead` contract change, any new migration.

## Decisions (with rationale — all flagged "confirm with user")

1. **Intent shape = free-text** (trim + non-empty + max length ≤120 via Zod). Matches the current schema (no enum/CHECK exists); an enum would need a future migration. _Confirm with user._
2. **Intent + confidence coupling** → `PUT /:id/intent` accepts `{ intent, intentConfidence? }`. `intent: null` CLEARS both. Confidence without intent → 422 (`INVALID_INTENT`). They may be set together. _Confirm with user._
3. **Tag normalization** → trim each tag; reject empty/whitespace-only; dedupe within the set; **preserve case** (user-facing labels); per-tag max length ≤60; max count ≤50. _Confirm with user._
4. **REST shape** = exploration Option A (focused endpoints, thin service over `repo.update`). All return `200` + updated Contact; `404` if contact absent/soft-deleted; `422` on validation. _Confirm with user._
5. **DELETE of an absent tag** → idempotent `200` no-op (mirrors the routing slice's idempotency). _Confirm with user._
6. **Size/delivery** → est. ~450 changed lines (~200 prod + ~250 tests), slightly over the 400 budget. Delivery decided after `sdd-tasks` (Review Workload Guard): either split tags-PR then intent-PR, or a justified `size:exception`. Flagged here, NOT decided. _Confirm with user._

## Capabilities

> This section is the CONTRACT between proposal and specs phases.

### New Capabilities
- `contact-tags`: validated assign/replace/remove of user-facing tag labels on a contact via `PUT /:id/tags` and `DELETE /:id/tags/:tag`.
- `contact-intent`: validated manual set/clear of a contact's intent (and optional confidence) via `PUT /:id/intent`.

### Modified Capabilities
- None. Existing `PATCH /:id` behavior is untouched; the new endpoints are additive and write the same Hub-internal columns.

## Approach

Each capability is a thin service (`contacts.tags.ts`, `contacts.intent.ts`) that validates/normalizes input, then delegates the write to the existing `repo.update(id, patch)` — no direct DB/`withTenant` handle (single-table writes don't need the atomic-cross-table pattern that `routeContact` required). `repo.update` already does the existence check (404 → `CONTACT_NOT_FOUND`), the `withTenant` RLS write (no `WHERE tenant_id`), `updated_at` touch, and `intentConfidence` string coercion. `DELETE /:id/tags/:tag` reads the contact, filters the value out, and writes the new set via `repo.update`. Each service returns `Result<Contact, E>`; route handlers map the union to HTTP via per-service mapper functions (consistent with `routingErrorToHttpStatus`). The three new handlers MUST be registered BEFORE the dynamic `/:id` wildcard so Hono first-match doesn't shadow them (established `/import`, `/:id/route` convention). Throw only at infra; `Result<T,E>` everywhere in domain.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/backend/src/contacts/contacts.tags.ts` | New | Tags service: replace/remove + trim/dedup/limits over `repo.update` |
| `apps/backend/src/contacts/contacts.tags.errors.ts` | New | `TagsError` union (`CONTACT_NOT_FOUND`, `DB_ERROR`) |
| `apps/backend/src/contacts/contacts.intent.ts` | New | Intent service: set/clear + value validation over `repo.update` |
| `apps/backend/src/contacts/contacts.intent.errors.ts` | New | `IntentError` union (`CONTACT_NOT_FOUND`, `INVALID_INTENT`, `DB_ERROR`) |
| `apps/backend/src/contacts/contacts.route.ts` | Modified | 3 handlers before `/:id` + 2 Result→HTTP mappers + Zod body schemas |
| `apps/backend/test/_helpers/test-db.ts` | Modified | Extend `seedTenant` with optional `tags?`, `intent?` |
| `apps/backend/test/contacts/contacts.tags.int.test.ts` | New | Integration tests (service + HTTP + tenant isolation) |
| `apps/backend/test/contacts/contacts.intent.int.test.ts` | New | Integration tests (service + HTTP + clear semantics) |

No migration. No contract change.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| New sub-path handlers shadowed by `/:id` wildcard | Med | Register `/:id/tags`, `/:id/tags/:tag`, `/:id/intent` BEFORE `/:id` (existing convention) |
| Free-text intent lets typos through silently | Med (by design) | Zod trim+non-empty+max-length guard; enum deferred as an explicit Non-goal — confirm with user |
| `intentConfidence` arrives as driver string | Low | Route through `repo.update` (already does `String(...)` coercion); intent service MUST NOT bypass it |
| TEXT[] does not enforce uniqueness at rest | Low | Service dedups before `repo.update`; PUT replaces full set |
| ~450-line diff over the 400 budget | Med | Flagged for the Review Workload Guard after `sdd-tasks` (split tags/intent PRs or `size:exception`) |

## Rollback Plan

Pure code revert — no DB state to undo (no migration, no schema change). Revert the two new service files, their error unions, the three route handlers + mappers in `contacts.route.ts`, the `seedTenant` extension, and the two test files. The pre-existing `PATCH /:id` path continues to accept `tags`/`intent`, so no capability regresses.

## Dependencies

- Existing `repo.update(id, patch)` and per-request repo factory (`apps/backend/src/contacts/contacts.repository.ts`).
- Existing tenant middleware (`c.get('tenantId')`, `withTenant` RLS) — read-only reference.

## Review Workload Forecast

- Estimated changed lines (per-file): `contacts.tags.ts` ~60; `contacts.tags.errors.ts` ~15; `contacts.intent.ts` ~50; `contacts.intent.errors.ts` ~15; `contacts.route.ts` ~70 (3 handlers + 2 mappers + schemas); `test-db.ts` ~10; tags tests ~130; intent tests ~100. **Total ≈ 450 changed lines (~200 prod + ~250 tests).**
- **400-line budget risk: Medium**
- **Chained PRs recommended: Yes** (clean split: tags-PR then intent-PR, each well under 400 lines and independently shippable)
- **Decision needed before apply: Yes** — the diff is ~450, over budget. Recommend either splitting into two micro-PRs (tags first, then intent) OR a justified `size:exception` (one cohesive "manual classification" capability, mostly low-risk tests). Resolve at the Review Workload Guard after `sdd-tasks`.

## Success Criteria

- [ ] `PUT /contacts/:id/tags` replaces the set, trims/dedups, enforces per-tag length ≤60 and count ≤50, returns `200` + updated Contact; bad input → `422`.
- [ ] `DELETE /contacts/:id/tags/:tag` removes one tag; removing an absent tag is an idempotent `200` no-op; unknown contact → `404`.
- [ ] `PUT /contacts/:id/intent` sets intent (+optional confidence); `intent: null` clears BOTH fields; confidence-without-intent → `422`; unknown contact → `404`.
- [ ] All writes go through `repo.update` (`withTenant` RLS, no `WHERE tenant_id`); tenant isolation holds under `app_rls` in integration tests.
- [ ] Domain logic returns `Result<T,E>` (never throws); new handlers registered before `/:id`; no migration, no `ContactLead` change.

## Open Questions for the User

1. Keep `intent` **free-text** (recommended) or constrain to an enum now (needs a future migration)?
2. OK that `intent: null` clears BOTH intent and confidence, and that confidence-without-intent is rejected (422)?
3. Tag rules OK: trim, dedupe, **preserve case**, max length ≤60, max count ≤50?
4. Confirm REST shape (PUT replace tags / DELETE one tag / PUT intent) and idempotent no-op on absent-tag delete?
5. Delivery preference if over budget: **split** (tags-PR then intent-PR) or single PR with `size:exception`?
