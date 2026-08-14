# Archive Report: contacts-tags-intent

**Change ID:** contacts-tags-intent  
**Status:** CLOSED — All tasks complete, both PRs merged to main  
**Archive Date:** 2026-06-27  
**Last Commit:** PR #9 (intent) merged to main

---

## Executive Summary

The **contacts-tags-intent** change ships two capabilities — **contact-tags** and **contact-intent** — to enable operators to manually manage tag labels and intent classification on WhatsApp contacts via three focused REST endpoints. All 23 integration test scenarios passed, both chained PRs merged to main (PR #8 tags, PR #9 intent), and tenant isolation verified. Change is now archived and requires no further action.

---

## Shipped Capabilities

### Capability 1: contact-tags
Three endpoints for tag management:
- **PUT /contacts/:id/tags** — Replace entire tag set; validates normalization (trim, dedupe, max-len ≤60, max-count ≤50)
- **DELETE /contacts/:id/tags/:tag** — Remove single tag; idempotent no-op if absent
- **Error codes:** CONTACT_NOT_FOUND (404), INVALID_TAGS (422), DB_ERROR (500)

**Canonical spec:** `openspec/specs/contact-tags/spec.md`

### Capability 2: contact-intent
One endpoint for intent management:
- **PUT /contacts/:id/intent** — Set/clear intent + optional confidence; validation: trim, max-len ≤120, confidence-without-intent → 422
- **Clear semantics:** intent=null clears both intent and intentConfidence
- **Error codes:** CONTACT_NOT_FOUND (404), INVALID_INTENT (422), DB_ERROR (500)

**Canonical spec:** `openspec/specs/contact-intent/spec.md`

---

## Delivery: Chained PRs (Merged)

| PR | Branch | Capability | Commits | Test Status | Status |
|----|--------|-----------|---------|-------------|--------|
| #8 | feat/contacts-tags | contact-tags | 3 commits | 12/12 PASSED | Merged to main |
| #9 | feat/contacts-intent | contact-intent | 3 commits | 11/11 PASSED | Merged to main |

Both PRs implemented via **Strict TDD** (RED → GREEN cycle):
1. Integration tests written first (failing)
2. Domain services + error unions implemented
3. Route handlers + Zod schemas wired
4. All tests GREEN before merge

**Total test coverage:** 23 integration scenarios across both capabilities.

---

## Implementation Summary

### Files Created

**PR #8 (Tags):**
- `apps/backend/src/contacts/contacts.tags.errors.ts` — TagsError union
- `apps/backend/src/contacts/contacts.tags.ts` — Domain service
- `apps/backend/test/contacts/contacts.tags.int.test.ts` — 12 integration tests
- `apps/backend/test/_helpers/test-db.ts` — Extended seedTenant with tags/intent/intentConfidence support (shared)

**PR #9 (Intent):**
- `apps/backend/src/contacts/contacts.intent.errors.ts` — IntentError union
- `apps/backend/src/contacts/contacts.intent.ts` — Domain service
- `apps/backend/test/contacts/contacts.intent.int.test.ts` — 11 integration tests

### Files Modified

- `apps/backend/src/contacts/contacts.route.ts` — Added 3 handlers (PUT /:id/tags, DELETE /:id/tags/:tag, PUT /:id/intent) + 2 Zod schemas + 2 error mappers, all before /:id wildcard
- (seedTenant extension already listed above, created once in PR #8)

### Design Decisions (All Confirmed)

1. **Intent shape:** Free-text, no enum (enum deferred to future migration)
2. **Tag normalization:** Trim, dedupe, preserve case, max-len ≤60, max-count ≤50
3. **Confidence coupling:** Requires intent (confidence-without-intent → 422)
4. **Clear both:** intent=null clears both intent and intentConfidence
5. **Idempotent no-ops:** Removing absent tag or clearing already-null intent returns 200 unchanged
6. **Zod → 400, Service → 422:** Structural errors 400, business-rule errors 422
7. **Delivery:** Chained PRs (tags then intent) under delivery_strategy=chained-pr, chain_strategy=stacked-to-main

---

## Test Results

### PR #8 (Tags) — All GREEN
- Replace tag set (happy path)
- Deduplicate while preserving case
- Trim whitespace
- Reject empty/whitespace-only tag (422)
- Reject tag >60 chars (422)
- Reject count >50 tags (422)
- 404 on absent/soft-deleted contact
- Tenant isolation (cross-tenant → 404)
- Remove existing tag
- Remove absent tag (idempotent 200)
- Remove on absent contact (404)
- Zod body validation (400)

**Result: 12/12 PASSED**

### PR #9 (Intent) — All GREEN
- Set intent only
- Set intent + confidence
- Reject empty intent (422)
- Reject whitespace-only intent (422)
- Reject intent >120 chars (422)
- Reject confidence-without-intent (422)
- Clear both via intent=null
- Idempotent clear
- 404 on absent/soft-deleted contact
- Tenant isolation
- Zod body validation (400)

**Result: 11/11 PASSED**

### Full Test Suite (Post-Merge)
- Backend suite: 317/317 PASSED
- Only 2 pre-existing unrelated failures (@sivihub/contracts unbuilt)

---

## Verification

- **Spec compliance:** All requirements from proposal + design implemented and tested
- **Tenant isolation:** Both capabilities enforce RLS; cross-tenant writes return 404
- **Idempotency:** PUT and DELETE operations are fully idempotent (repeated calls same result)
- **Error handling:** Correct HTTP status codes (400 Zod, 404 not found, 422 business rule)
- **Route ordering:** Handlers registered before /:id wildcard (Hono first-match convention)
- **No schema migration:** Both capabilities use existing columns (tags TEXT[], intent TEXT, intentConfidence NUMERIC)
- **No ContactLead change:** Hub-internal only

---

## Artifacts Synced

- ✅ `openspec/specs/contact-tags/spec.md` — Canonical spec created
- ✅ `openspec/specs/contact-intent/spec.md` — Canonical spec created
- ✅ Archive report (this file)

---

## Rollback Info

Pure code revert — no database migration to undo:
1. Revert PR #9 (intent branch)
2. Revert PR #8 (tags branch)
3. Pre-existing PATCH /:id still accepts tags/intent — no capability loss

---

## Sign-off

| Role | Timestamp | Status |
|------|-----------|--------|
| Implementation | 2026-06-26 18:42:57 | Complete (all tasks GREEN) |
| Verification | Via integration tests | GREEN |
| Archive | 2026-06-27 | CLOSED |

---

## Next Steps

None. The change is complete and archived. The operator now has three new endpoints (PUT/DELETE /:id/tags, PUT /:id/intent) for manual contact classification in Corte 1.
