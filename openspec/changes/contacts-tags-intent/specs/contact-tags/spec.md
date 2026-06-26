# Contact Tags Specification

## Purpose

Provides validated assign/replace/remove of user-facing tag labels on a contact. Tags are operator-supplied strings used for manual classification. No auto-tagging, bulk analytics, or rename/merge is in scope.

## Requirements

### Requirement: Replace Full Tag Set

The system MUST replace the entire tag set for a contact when `PUT /contacts/:id/tags` is called with a `{ tags: string[] }` body. Before persisting, the system MUST apply all normalization rules in order: trim whitespace from each tag, reject the request with `422` if any tag is empty or whitespace-only after trimming, deduplicate the resulting set (case-sensitive, first-occurrence wins), and reject the request with `422` if any tag exceeds 60 characters or if the final count exceeds 50. The system MUST return `200` and the updated Contact on success, `404` if the contact does not exist or is soft-deleted, and `422` on validation failure. All writes MUST go through `repo.update` under RLS; no `WHERE tenant_id` clause is permitted.

#### Scenario: Happy path — valid tag set replaces existing tags

- GIVEN a contact exists for the authenticated tenant with tags `["old"]`
- WHEN `PUT /contacts/:id/tags` is called with `{ tags: ["Sales", "VIP"] }`
- THEN the response is `200` with the updated contact where `tags` equals `["Sales", "VIP"]`

#### Scenario: Normalization — duplicates are deduplicated

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/tags` is called with `{ tags: ["Lead", "Lead", "VIP"] }`
- THEN the response is `200` with `tags` equal to `["Lead", "VIP"]`

#### Scenario: Normalization — tags are trimmed

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/tags` is called with `{ tags: ["  Sales  "] }`
- THEN the response is `200` with `tags` equal to `["Sales"]`

#### Scenario: Validation failure — empty or whitespace-only tag

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/tags` is called with `{ tags: ["  "] }`
- THEN the response is `422`

#### Scenario: Validation failure — tag exceeds 60 characters

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/tags` is called with a tag of 61 characters
- THEN the response is `422`

#### Scenario: Validation failure — tag count exceeds 50

- GIVEN a contact exists for the authenticated tenant
- WHEN `PUT /contacts/:id/tags` is called with 51 tags
- THEN the response is `422`

#### Scenario: Contact not found

- GIVEN no contact exists for the authenticated tenant with the given id
- WHEN `PUT /contacts/:id/tags` is called
- THEN the response is `404`

#### Scenario: Tenant isolation — cross-tenant write is blocked

- GIVEN contact A belongs to tenant 1 and the request is authenticated as tenant 2
- WHEN `PUT /contacts/A/tags` is called with a valid body
- THEN the response is `404` and tenant 1's contact is unchanged

---

### Requirement: Remove Single Tag

The system MUST remove one tag from a contact's tag set when `DELETE /contacts/:id/tags/:tag` is called. If the tag is not present in the current set, the system MUST return `200` with the unchanged contact (idempotent no-op). The system MUST return `404` if the contact does not exist or is soft-deleted. All writes MUST go through `repo.update` under RLS.

#### Scenario: Happy path — existing tag is removed

- GIVEN a contact exists with `tags = ["Lead", "VIP"]`
- WHEN `DELETE /contacts/:id/tags/Lead` is called
- THEN the response is `200` with `tags` equal to `["VIP"]`

#### Scenario: Idempotent no-op — tag is absent

- GIVEN a contact exists with `tags = ["VIP"]`
- WHEN `DELETE /contacts/:id/tags/Lead` is called
- THEN the response is `200` with `tags` equal to `["VIP"]` and no write occurs

#### Scenario: Contact not found

- GIVEN no contact exists for the authenticated tenant with the given id
- WHEN `DELETE /contacts/:id/tags/:tag` is called
- THEN the response is `404`
