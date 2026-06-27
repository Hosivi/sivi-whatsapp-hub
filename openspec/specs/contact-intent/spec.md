# Capability Spec: contact-intent

Validated manual assignment and clearing of intent (classification/next-action label) on WhatsApp contacts, with optional confidence scoring.

## Overview

Allows operators to manually set or clear a contact's intent via a single REST endpoint. Intent is free-text (no enum), trimmed, and validated for length. Optional confidence score (0–1) is accepted only when intent is present. All writes use the existing `repo.update` under RLS isolation. No schema change required; columns `intent TEXT` and `intentConfidence NUMERIC(5,4)` already present.

## Requirements

### Requirement: Set or Update Intent

**PUT /contacts/:id/intent** — Sets or updates the intent and optional confidence for a contact.

**Request:**
```json
{
  "intent": "string",
  "intentConfidence": 0.75
}
```
or to clear:
```json
{
  "intent": null
}
```

**Validation (intent field):**
- Trim the intent string
- Reject if empty or whitespace-only after trim (422 INVALID_INTENT)
- Reject if exceeds 120 characters (422 INVALID_INTENT)

**Validation (intentConfidence field):**
- Optional; if omitted, defaults to null
- Must be null or a number in range [0, 1] inclusive
- If provided and non-null, REQUIRES intent to be present (non-null) — reject with 422 INVALID_INTENT if confidence is set but intent is null/missing

**Response:**
- **200 OK** + updated Contact object (all fields including new `intent` and `intentConfidence`)
- **400 Bad Request** — Zod validation failure (wrong type)
- **404 Not Found** — Contact absent or soft-deleted
- **422 Unprocessable Entity** — Business rule violation (INVALID_INTENT)

**Behavior:**
- Idempotent: setting intent to the same value multiple times returns 200 with no state change
- Clearing (intent: null) sets BOTH `intent` and `intentConfidence` to null
- All writes go through `repo.update` under tenant RLS isolation (no WHERE tenant_id in query)
- Tenant isolation enforced: attempt to write cross-tenant → 404

**Scenarios:**
- Happy path: set intent only → 200 + contact with intent set, confidence null
- Happy path: set intent + confidence → 200 + contact with both fields set
- Clear both: intent=null clears both intent and intentConfidence to null → 200
- Idempotent clear: already null → 200 still null/null
- Validation: empty string → 422 INVALID_INTENT
- Validation: whitespace-only → 422 INVALID_INTENT
- Validation: >120 chars → 422 INVALID_INTENT
- Validation: confidence without intent → 422 INVALID_INTENT (e.g., `{ intent: null, intentConfidence: 0.8 }`)
- Validation: confidence with missing intent field → 422 INVALID_INTENT (e.g., `{ intentConfidence: 0.8 }`)
- 404: contact absent/soft-deleted
- Tenant isolation: cross-tenant write → 404, other tenant's contact unchanged

---

### Requirement: Clear Intent and Confidence

Sending `intent: null` in the request body clears BOTH `intent` and `intentConfidence` to null. This is distinct from omitting the field entirely (omitting = no change).

---

### Requirement: Confidence Requires Intent

If `intentConfidence` is provided and non-null while `intent` is null or absent from the body, reject with **422 INVALID_INTENT**. Confidence must never be persisted without intent.

---

## Affected Endpoints

| Method | Path | New/Modified | Purpose |
|--------|------|--------------|---------|
| PUT | `/contacts/:id/intent` | New | Set or clear intent and optional confidence |

---

## Dependencies

- Existing `repo.update(id, patch)` in contacts.repository.ts
- Tenant middleware: `c.get('tenantId')`, tenant RLS (withTenant)
- Zod for structural validation
- `repo.update` already handles intentConfidence String() coercion and null-handling

---

## Implementation Notes

- **Domain service:** `contacts.intent.ts` — single function: `setIntent(repo, id, intent, intentConfidence?)` returning `Result<Contact, IntentError>`
- **Error union:** `IntentError` = `CONTACT_NOT_FOUND | INVALID_INTENT | DB_ERROR`
- **Route registration:** Handler registered BEFORE the `/:id` wildcard in contacts.route.ts (Hono first-match rule)
- **Testing:** Integration tests with Testcontainers (`app_rls` tenant context); confidence-without-intent rejection, clear-both semantics, and cross-tenant isolation all verified
- **Type coercion:** `repo.update` internally coerces intentConfidence to String for Postgres NUMERIC column; service must never bypass this
