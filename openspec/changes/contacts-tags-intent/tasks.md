# Tasks: Contact Tags + Manual Intent — Focused Endpoints

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~450 (~200 prod + ~250 tests) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: tags (errors + service + route + tests) → PR 2: intent (errors + service + route + tests) |
| Delivery strategy | single-pr |
| Chain strategy | pending (size:exception OR stacked-to-main — resolve at Review Workload Guard) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Tags error union + service + route handlers + integration tests | PR 1 | Independently shippable; ~220 lines |
| 2 | Intent error union + service + route handler + integration tests | PR 2 | Depends on `seedTenant` extension from Unit 1 |

---

## Phase 1: Foundation

- [ ] 1.1 Create `apps/backend/src/contacts/contacts.tags.errors.ts`: export `TagsError` discriminated union with codes `CONTACT_NOT_FOUND`, `INVALID_TAGS`, `DB_ERROR`. _(spec: tags replace/remove → 404/422; design: TagsError authoritative with 3 codes)_
- [ ] 1.2 Create `apps/backend/src/contacts/contacts.intent.errors.ts`: export `IntentError` discriminated union with codes `CONTACT_NOT_FOUND`, `INVALID_INTENT`, `DB_ERROR`. _(spec: intent set/clear → 404/422; design: IntentError)_
- [ ] 1.3 Extend `seedTenant` in `apps/backend/test/_helpers/test-db.ts` to accept optional `tags?: string[]`, `intent?: string | null`, and `intentConfidence?: number | null`; pass them through to the `adminDb.insert` call. _(design: testing strategy — seed via seedTenant)_

## Phase 2: RED — Failing Integration Tests

- [ ] 2.1 Create `apps/backend/test/contacts/contacts.tags.int.test.ts` (failing). Cover: replace happy path (200 + updated tags); deduplicate preserving case; trim tags; empty/whitespace tag → 422; tag >60 chars → 422; count >51 tags → 422; unknown contact → 404; cross-tenant write → 404 (RLS isolation); remove existing tag → 200; remove absent tag → idempotent 200 no-op; remove on unknown contact → 404; Zod body invalid → 400. _(all scenarios from contact-tags spec)_
- [ ] 2.2 Create `apps/backend/test/contacts/contacts.intent.int.test.ts` (failing). Cover: set intent without confidence → 200; set intent with confidence 0.9 → 200; intent null clears both fields → 200; idempotent clear when already null → 200; empty intent string → 422; whitespace-only intent → 422; intent >120 chars → 422; confidence-without-intent (intent null + confidence 0.8) → 422 `INVALID_INTENT`; out-of-range intentConfidence (1.5) → 400 (Zod); unknown contact → 404; cross-tenant write → 404 (RLS isolation). _(all scenarios from contact-intent spec)_

## Phase 3: GREEN — Service Implementation

- [ ] 3.1 Create `apps/backend/src/contacts/contacts.tags.ts`: `replaceTags(repo, id, tags)` — trim each → reject any empty/whitespace (`INVALID_TAGS`) → dedupe case-sensitive first-occurrence → reject per-tag >60 chars or count >50 (`INVALID_TAGS`) → `repo.update`; `removeTag(repo, id, tag)` — `repo.findById` → filter by exact value → `repo.update` (idempotent no-op if absent); both return `Result<Contact, TagsError>`. _(design: contacts.tags.ts; spec: replace + remove requirements)_
- [ ] 3.2 Create `apps/backend/src/contacts/contacts.intent.ts`: `setIntent(repo, id, intent, intentConfidence?)` — if `intent` is non-null: trim → reject empty/whitespace or >120 chars (`INVALID_INTENT`) → reject non-null confidence with null intent (`INVALID_INTENT`) → `repo.update`; if `intent` is null: clear both to null via `repo.update`; returns `Result<Contact, IntentError>`. _(design: contacts.intent.ts; spec: set/clear/coupling requirements)_

## Phase 4: GREEN — Route Wiring

- [ ] 4.1 Add `tagsBody` Zod schema (`z.object({ tags: z.array(z.string()) })`) and `intentBody` Zod schema (`intent: z.string().nullable()`, `intentConfidence: z.number().min(0).max(1).nullable().optional()`) to `apps/backend/src/contacts/contacts.route.ts`. _(design: Zod structure-only; W1: out-of-range confidence → 400 via Zod)_
- [ ] 4.2 Add `tagsErrorToHttpStatus` mapper (exhaustive switch: `CONTACT_NOT_FOUND` → 404, `INVALID_TAGS` → 422, `DB_ERROR` → 500) and `intentErrorToHttpStatus` mapper (same shape with `INVALID_INTENT` → 422) to `contacts.route.ts`. _(design: per-service mappers; ADR-2 exhaustive switch pattern)_
- [ ] 4.3 Register `PUT /:id/tags` (calls `replaceTags`), `DELETE /:id/tags/:tag` (calls `removeTag`), and `PUT /:id/intent` (calls `setIntent`) handlers in `contacts.route.ts` BEFORE the `/:id` wildcard; each parses body with Zod → calls service → maps result to HTTP via its mapper. _(design: route order; spec: all three endpoints; design: data flow)_

## Phase 5: Verification

- [ ] 5.1 Run `pnpm test --filter=backend` — all tags and intent integration tests must be GREEN; existing contacts tests (`contacts.route.int.test.ts`, `rls.int.test.ts`, `contacts.repository.int.test.ts`) must show no regressions. _(spec: all success criteria; design: no migration, PATCH /:id path unchanged)_
