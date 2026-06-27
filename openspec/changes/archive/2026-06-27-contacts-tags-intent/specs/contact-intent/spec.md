# Contact Intent Specification

## Purpose

Provides validated manual set and clear of a contact's intent field and optional confidence score. Intent is a free-text label (no enum) used for manual classification. Auto-intent inference and enum migration are explicit non-goals.

## Requirements

### Requirement: Set or Update Intent

The system MUST set or update a contact's intent when `PUT /contacts/:id/intent` is called with `{ intent: string, intentConfidence?: number | null }`. Before persisting, the system MUST apply Zod validation: trim the intent string, reject with `422` if the trimmed value is empty or whitespace-only, and reject with `422` if the trimmed value exceeds 120 characters. `intentConfidence` is optional; when provided it MUST be a number between 0 and 1 (inclusive) or `null`. The system MUST return `200` and the updated Contact on success, `404` if the contact does not exist or is soft-deleted, and `422` on validation failure. All writes MUST go through `repo.update` under RLS; no `WHERE tenant_id` clause is permitted.

#### Scenario: Happy path — set intent without confidence

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/intent` is called with `{ intent: "interested-in-service" }`
- THEN the response is `200` with `intent` equal to `"interested-in-service"` and `intentConfidence` unchanged

#### Scenario: Happy path — set intent with confidence

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/intent` is called with `{ intent: "interested-in-service", intentConfidence: 0.9 }`
- THEN the response is `200` with `intent` equal to `"interested-in-service"` and `intentConfidence` equal to `0.9`

#### Scenario: Validation failure — empty string intent

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/intent` is called with `{ intent: "" }`
- THEN the response is `422`

#### Scenario: Validation failure — whitespace-only intent

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/intent` is called with `{ intent: "   " }`
- THEN the response is `422`

#### Scenario: Validation failure — intent exceeds 120 characters

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/intent` is called with an intent string of 121 characters
- THEN the response is `422`

#### Scenario: Contact not found

- GIVEN no contact exists for the authenticated tenant with the given id
- WHEN `PUT /contacts/:id/intent` is called
- THEN the response is `404`

#### Scenario: Tenant isolation — cross-tenant write is blocked

- GIVEN contact A belongs to tenant 1 and the request is authenticated as tenant 2
- WHEN `PUT /contacts/A/intent` is called with a valid body
- THEN the response is `404` and tenant 1's contact is unchanged

---

### Requirement: Clear Intent and Confidence

The system MUST clear both `intent` and `intentConfidence` to `null` when `PUT /contacts/:id/intent` is called with `{ intent: null }`. Passing `intent: null` is the only supported clear mechanism; omitting the field is not equivalent to clearing.

#### Scenario: Clear both fields

- GIVEN a contact exists with `intent = "interested-in-service"` and `intentConfidence = 0.9`
- WHEN `PUT /contacts/:id/intent` is called with `{ intent: null }`
- THEN the response is `200` with `intent` equal to `null` and `intentConfidence` equal to `null`

#### Scenario: Clear is idempotent when already null

- GIVEN a contact exists with `intent = null` and `intentConfidence = null`
- WHEN `PUT /contacts/:id/intent` is called with `{ intent: null }`
- THEN the response is `200` with both fields still `null`

---

### Requirement: Confidence Requires Intent

The system MUST reject with `422` (`INVALID_INTENT`) when `intentConfidence` is provided with a non-null value and `intent` is `null` or absent. Confidence without intent is semantically invalid and MUST NOT be persisted.

#### Scenario: Confidence without intent is rejected

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/intent` is called with `{ intent: null, intentConfidence: 0.8 }`
- THEN the response is `422` with error code `INVALID_INTENT`

#### Scenario: Confidence with valid intent is accepted

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/intent` is called with `{ intent: "follow-up", intentConfidence: 0.75 }`
- THEN the response is `200` and both fields are persisted
