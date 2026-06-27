# Capability Spec: contact-tags

Validated assignment, replacement, and removal of tag labels on WhatsApp contacts.

## Overview

Allows operators to manage tags on contacts via three REST endpoints. Tags are normalized (trimmed, deduplicated), validated for length and count, and persisted via the existing `repo.update` under RLS isolation. No schema change required; column `tags TEXT[]` already present.

## Requirements

### Requirement: Replace Full Tag Set

**PUT /contacts/:id/tags** — Replaces the entire tag set for a contact.

**Request:**
```json
{
  "tags": ["string", "..."]
}
```

**Validation:**
- Trim each tag
- Reject if any tag is empty or whitespace-only after trim (422 INVALID_TAGS)
- Reject if any tag exceeds 60 characters (422 INVALID_TAGS)
- Deduplicate, preserving case and first-occurrence order
- Reject if final count exceeds 50 tags (422 INVALID_TAGS)

**Response:**
- **200 OK** + updated Contact object (all fields including new `tags`)
- **400 Bad Request** — Zod validation failure (wrong type)
- **404 Not Found** — Contact absent or soft-deleted
- **422 Unprocessable Entity** — Business rule violation (INVALID_TAGS)

**Behavior:**
- Idempotent: sending the same tags multiple times returns 200 with no state change
- All writes go through `repo.update` under tenant RLS isolation (no WHERE tenant_id in query)
- Tenant isolation enforced: attempt to write cross-tenant → 404

**Scenarios:**
- Happy path: valid tags replace existing set → 200 + updated contact
- Dedup: ["Lead","Lead","VIP"] → ["Lead","VIP"]
- Trim: ["  Sales  "] → ["Sales"]
- Validation: whitespace-only tag → 422 INVALID_TAGS
- Validation: tag >60 chars → 422 INVALID_TAGS
- Validation: >50 tags → 422 INVALID_TAGS
- 404: contact absent/soft-deleted
- Tenant isolation: cross-tenant write → 404, other tenant's contact unchanged

---

### Requirement: Remove Single Tag

**DELETE /contacts/:id/tags/:tag** — Removes a single tag by name (case-sensitive).

**Validation:**
- Tag name extracted from URL path
- No body required

**Response:**
- **200 OK** + updated Contact object (tag removed from `tags` array, or unchanged if tag was absent)
- **404 Not Found** — Contact absent or soft-deleted
- **422 Unprocessable Entity** — Tag name invalid (e.g., exceeds 255 chars, binary data)

**Behavior:**
- Idempotent: removing a tag that doesn't exist returns 200 with unchanged tags
- Case-sensitive match (e.g., "Lead" and "lead" are different)
- Operates via: `repo.findById(id)` → filter tag from array → `repo.update(id, patch)` under RLS
- Tenant isolation: no cross-tenant mutation possible (RLS blocks unauthorized access)

**Scenarios:**
- Happy path: existing tag removed → 200 + updated tags
- Idempotent no-op: tag absent → 200 unchanged
- 404: contact absent/soft-deleted

---

## Affected Endpoints

| Method | Path | New/Modified | Purpose |
|--------|------|--------------|---------|
| PUT | `/contacts/:id/tags` | New | Replace entire tag set |
| DELETE | `/contacts/:id/tags/:tag` | New | Remove single tag |

---

## Dependencies

- Existing `repo.update(id, patch)` in contacts.repository.ts
- Existing `repo.findById(id)` in contacts.repository.ts
- Tenant middleware: `c.get('tenantId')`, tenant RLS (withTenant)
- Zod for structural validation

---

## Implementation Notes

- **Domain service:** `contacts.tags.ts` — two functions: `replaceTags(repo, id, tags)` and `removeTag(repo, id, tag)`, both return `Result<Contact, TagsError>`
- **Error union:** `TagsError` = `CONTACT_NOT_FOUND | INVALID_TAGS | DB_ERROR`
- **Route registration:** Both handlers registered BEFORE the `/:id` wildcard in contacts.route.ts (Hono first-match rule)
- **Testing:** Integration tests with Testcontainers (`app_rls` tenant context); cross-tenant isolation verified
