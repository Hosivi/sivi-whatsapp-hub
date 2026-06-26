# Design: Contact Tags + Manual Intent — Focused Endpoints

## Technical Approach

Two thin domain services (`contacts.tags.ts`, `contacts.intent.ts`) validate/normalize input
and delegate every write to the existing `repo.update(id, patch)`, which already performs the
RLS `withTenant` write (no `WHERE tenant_id`), the live-contact existence check
(`CONTACT_NOT_FOUND`), the `updated_at` touch, and `intentConfidence` string coercion. Each
service returns `Result<Contact, E>` with its own error union. `contacts.route.ts` gains three
handlers — registered BEFORE the dynamic `/:id` so Hono first-match does not shadow them —
each mapping its union to HTTP via a dedicated mapper that mirrors `routingErrorToHttpStatus`.
No migration, no `ContactLead` change.

## Architecture Decisions

| Decision | Choice | Alternatives rejected | Rationale |
|----------|--------|-----------------------|-----------|
| Write path | Thin service over `repo.update` | New repo methods; direct `withTenant` in service | `repo.update` already does existence + RLS write + coercion; single-table writes need no cross-table atomicity (unlike `routeContact`). |
| Validation split | Zod = structure (→400); service = business rules (→422) | All rules in Zod (→400 only) | Matches success criteria ("bad input → 422") and mirrors `INVALID_INTENT`. Well-formed-but-illegal values are 422 (Unprocessable Entity). |
| Tags error union | Add `INVALID_TAGS` to `TagsError` | Proposal's literal `{CONTACT_NOT_FOUND, DB_ERROR}` | The proposal's own success criterion demands a tag 422 path; symmetric with intent. **Deviation flagged below.** |
| DELETE one tag | `findById` → filter → `repo.update` (two txs) | Single atomic read-filter-write tx | Proposal accepts non-atomic single-table writes; idempotent no-op tolerates the tiny race. |
| Error→HTTP | Per-service mapper functions | Shared mapper over a merged union | Keeps each `switch` exhaustive over its own codes (established ADR-2 pattern). |

## Data Flow

    PUT /:id/tags ─→ Zod(structure) ─→ tagsService.replace ─→ normalize+limits ─→ repo.update ─→ 200 Contact
    DELETE /:id/tags/:tag ─→ tagsService.remove ─→ repo.findById ─→ filter ─→ repo.update ─→ 200 Contact
    PUT /:id/intent ─→ Zod(structure) ─→ intentService.set ─→ rule(conf⇒intent) ─→ repo.update ─→ 200 Contact

`repo.update` returns only `CONTACT_NOT_FOUND | DB_ERROR`; services re-bubble those into their
own union and add their validation codes.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/backend/src/contacts/contacts.tags.ts` | Create | `replaceTags` / `removeTag` over `repo.update`; trim, drop-empty, dedupe (preserve case). |
| `apps/backend/src/contacts/contacts.tags.errors.ts` | Create | `TagsError = CONTACT_NOT_FOUND \| INVALID_TAGS \| DB_ERROR`. |
| `apps/backend/src/contacts/contacts.intent.ts` | Create | `setIntent`; `intent:null` clears both; confidence-without-intent → `INVALID_INTENT`. |
| `apps/backend/src/contacts/contacts.intent.errors.ts` | Create | `IntentError = CONTACT_NOT_FOUND \| INVALID_INTENT \| DB_ERROR`. |
| `apps/backend/src/contacts/contacts.route.ts` | Modify | 3 handlers (before `/:id`) + 2 mappers + 2 Zod schemas. |
| `apps/backend/test/_helpers/test-db.ts` | Modify | `seedTenant` gains optional `tags?`, `intent?`. |
| `apps/backend/test/contacts/contacts.tags.int.test.ts` | Create | Service + HTTP + tenant isolation. |
| `apps/backend/test/contacts/contacts.intent.int.test.ts` | Create | Service + HTTP + clear semantics. |

## Interfaces / Contracts

```ts
// service signatures (Result everywhere, no throws in domain)
replaceTags(repo, id, tags: string[]): Promise<Result<Contact, TagsError>>;
removeTag(repo, id, tag: string): Promise<Result<Contact, TagsError>>;
setIntent(repo, id, intent: string | null, intentConfidence?: number | null)
  : Promise<Result<Contact, IntentError>>;

// Zod (structure only; semantic limits live in the service)
tagsBody   = z.object({ tags: z.array(z.string()) });
intentBody = z.object({
  intent: z.string().nullable(),
  intentConfidence: z.number().min(0).max(1).nullable().optional(),
});
```

Mappers: `tagsErrorToHttpStatus` → 404/422/500; `intentErrorToHttpStatus` → 404/422/500.
`DB_ERROR` surfaces as body `{ error: 'INTERNAL_ERROR' }` (existing convention).

Normalization (tags service): trim each → reject empty/whitespace-only (`INVALID_TAGS`) →
dedupe preserving case → enforce per-tag ≤60 and count ≤50 (`INVALID_TAGS`). `removeTag`
filters by exact value; absent tag → idempotent 200 no-op.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Service (integration) | replace/dedupe/limits; set/clear; confidence coupling; absent-tag no-op; 404 | Testcontainers `withTenant` (app_rls), seed via `seedTenant`. |
| HTTP | status codes (200/404/422), body shape, route order not shadowed by `/:id` | `buildApp` + `fetch`/`app.request`. |
| RLS isolation | tenant A cannot mutate tenant B's contact | Two seeded tenants under `app_rls`; assert `CONTACT_NOT_FOUND`/0 rows. |

## Migration / Rollout

No migration required. Pure additive code; `PATCH /:id` path unchanged. Rollback = code revert.

## Open Questions

- [ ] **ADR deviation**: add `INVALID_TAGS` to `TagsError` (needed for the proposal's tag-422
  success criterion; proposal text listed only `CONTACT_NOT_FOUND, DB_ERROR`). Confirm.
- [ ] Confirm 422 (not 400) for tag length/count and confidence-without-intent business rules.
