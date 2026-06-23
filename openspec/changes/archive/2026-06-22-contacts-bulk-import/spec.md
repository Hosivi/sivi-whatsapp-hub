# Delta Spec — contacts-bulk-import

> SDD phase: spec · Change: contacts-bulk-import · Project: sivi-whatsapp-hub
> Artifact store: hybrid
> Extends: `openspec/specs/contacts/spec.md`
> Proposal: `openspec/changes/2026-06-22-contacts-bulk-import/proposal.md`

---

## ADDED Requirements

---

### Requirement: ImportRow Schema

The system MUST accept each row in the import batch with the following shape. `phone` is the only required field; all others are optional and nullable.

| Field | Type | Required |
|---|---|---|
| `phone` | `string` (min 1) | YES |
| `fullName` | `string \| null` | no |
| `source` | `string \| null` | no |
| `tags` | `string[]` | no |
| `intent` | `string \| null` | no |
| `intentConfidence` | `number (0–1) \| null` | no |

The batch wrapper MUST be `{ contacts: ImportRow[] }` with `contacts.length >= 1` and `contacts.length <= 200`. Violating either bound is a batch-level error (400), not a per-row error.

---

### Requirement: RowOutcome Enum

The system MUST classify each input row with exactly one of the following outcomes:

| Outcome | Meaning |
|---|---|
| `imported` | New contact created; row was valid and phone did not exist. |
| `resurrected` | Soft-deleted contact with the same phone was reactivated (same `id`, `deleted_at` cleared). |
| `skipped-invalid-phone` | Phone failed `normalizePhoneE164`; no DB operation performed. |
| `skipped-duplicate-in-batch` | A prior row in the same batch already claimed this normalized phone. |
| `skipped-already-exists` | A live contact with the same normalized phone already exists (includes concurrent-create race caught by 23505). |
| `error` | An unexpected infrastructure error (DB_ERROR) occurred while processing this row; remaining rows are still processed. |

---

### Requirement: importContacts Service

`importContacts(repo: ContactsRepository, rows: ImportRow[]): Promise<ImportReport>` MUST:

- Normalize each row's phone via `normalizePhoneE164` (per-row, preserving `index`).
- Detect within-batch duplicates over the valid normalized phones via `detectPhoneDuplicates`; only the first occurrence (lowest index) proceeds; later occurrences become `skipped-duplicate-in-batch` with `canonicalRowIndex` pointing to the first occurrence.
- For each valid, in-batch-unique phone: invoke `repo.create(row)` in a separate `withTenant` transaction (NO outer transaction wrapper).
- Map `repo.create` results: `ok(contact)` → `imported` or `resurrected` (determined by whether `contact.deletedAt` was previously set — the repo handles this transparently); `err(CONTACT_ALREADY_EXISTS)` → `skipped-already-exists`.
- Return `ImportReport` with `summary` counts and per-row `rows` array in submission order.
- MUST NOT use `WHERE tenant_id` — RLS via `withTenant` only.
- MUST return `Result<T, E>` shapes in domain logic; MUST NOT throw.

---

### Requirement: POST /contacts/import — Batch Import Endpoint

`POST /contacts/import` MUST accept a JSON body, validate via Zod, invoke `importContacts`, and return HTTP 200 with `ImportReport`.

Request body: `{ contacts: ImportRow[] }`

Response body (HTTP 200 or 500 when errors > 0):
```
{
  summary: {
    total: number,
    imported: number,
    resurrected: number,
    skippedInvalidPhone: number,
    skippedDuplicateInBatch: number,
    skippedAlreadyExists: number,
    errors: number
  },
  rows: Array<{
    index: number,          // 0-based, preserves submission order
    input: ImportRow,       // original row as received
    outcome: RowOutcome,
    contactId?: string,     // present when outcome is imported | resurrected
    reason?: string,        // present when outcome is skipped-invalid-phone
    canonicalRowIndex?: number,  // present when outcome is skipped-duplicate-in-batch
    code?: string           // present when outcome is error
  }>
}
```

Batch-level 400 errors (before per-row processing):
- Empty array (`contacts.length < 1`) → `{ "error": "VALIDATION_ERROR", "details": [...] }`
- Over-limit (`contacts.length > 200`) → `{ "error": "VALIDATION_ERROR", "details": [...] }`
- Malformed body (not parseable JSON, missing `contacts` key) → `{ "error": "VALIDATION_ERROR", "details": [...] }`

DB_ERROR on any row → HTTP 500 (full report body still returned, `summary.errors > 0`).

---

#### Scenario: valid new row → imported

- GIVEN a tenant with no existing contact for phone `"987654321"`
- WHEN `POST /contacts/import` with `{ contacts: [{ phone: "987654321", fullName: "Ana" }] }` is called
- THEN the response status is `200`
- AND `body.rows[0].outcome` is `"imported"`
- AND `body.rows[0].contactId` is a UUID
- AND `body.summary.imported` is `1`
- AND a contact with `phone_e164 = "+51987654321"` exists in the DB for that tenant

---

#### Scenario: row whose phone matches soft-deleted contact → resurrected

- GIVEN a contact with `phone_e164 = "+51987654321"` was soft-deleted (`deleted_at` is set) for the current tenant
- WHEN `POST /contacts/import` with `{ contacts: [{ phone: "+51987654321", fullName: "Ana Reborn" }] }` is called
- THEN the response status is `200`
- AND `body.rows[0].outcome` is `"resurrected"`
- AND `body.rows[0].contactId` equals the original contact's `id` (same row, not a new one)
- AND the contact's `deleted_at` is now `null`
- AND `body.summary.resurrected` is `1`

---

#### Scenario: row whose phone matches a live contact → skipped-already-exists

- GIVEN a live contact with `phone_e164 = "+51987654321"` exists for the current tenant
- WHEN `POST /contacts/import` with `{ contacts: [{ phone: "+51987654321" }] }` is called
- THEN the response status is `200`
- AND `body.rows[0].outcome` is `"skipped-already-exists"`
- AND `body.rows[0].contactId` is undefined
- AND `body.summary.skippedAlreadyExists` is `1`
- AND the existing contact row is NOT modified

---

#### Scenario: two rows with same phone in one batch → first imported, second skipped-duplicate-in-batch

- GIVEN the current tenant has no existing contact for phone `"987654321"`
- WHEN `POST /contacts/import` with `{ contacts: [{ phone: "987654321" }, { phone: "+51987654321" }] }` is called
- THEN the response status is `200`
- AND `body.rows[0].outcome` is `"imported"` with a `contactId`
- AND `body.rows[1].outcome` is `"skipped-duplicate-in-batch"`
- AND `body.rows[1].canonicalRowIndex` is `0`
- AND `body.summary.imported` is `1`
- AND `body.summary.skippedDuplicateInBatch` is `1`
- AND exactly ONE contact row exists in the DB for that phone

---

#### Scenario: row with invalid phone → skipped-invalid-phone (200 report, no DB row)

- GIVEN any tenant state
- WHEN `POST /contacts/import` with `{ contacts: [{ phone: "abcdef" }] }` is called
- THEN the response status is `200`
- AND `body.rows[0].outcome` is `"skipped-invalid-phone"`
- AND `body.rows[0].reason` is `"INVALID_FORMAT"` (or `"EMPTY_INPUT"` for blank phone)
- AND `body.summary.skippedInvalidPhone` is `1`
- AND no DB row is created

---

### Requirement: Batch-Level 400 Validation

The endpoint MUST reject the entire request with HTTP 400 before any per-row processing occurs when the batch violates structural constraints.

#### Scenario: empty contacts array → 400

- GIVEN a valid tenant header is set
- WHEN `POST /contacts/import` with `{ contacts: [] }` is called
- THEN the response status is `400`
- AND the body is `{ "error": "VALIDATION_ERROR", "details": [...] }`
- AND no contact is created

---

#### Scenario: more than 200 rows → 400

- GIVEN a valid tenant header is set
- WHEN `POST /contacts/import` with an array of 201 rows is called
- THEN the response status is `400`
- AND the body is `{ "error": "VALIDATION_ERROR", "details": [...] }`

---

#### Scenario: malformed body → 400

- GIVEN a valid tenant header is set
- WHEN `POST /contacts/import` is called with body `"not-json"` or `{}` (missing `contacts` key)
- THEN the response status is `400`
- AND the body is `{ "error": "VALIDATION_ERROR", "details": [...] }`

---

### Requirement: Tenant Isolation for Bulk Import

Contacts imported under tenant A MUST NOT be visible to tenant B. RLS via `withTenant` enforces this; no `WHERE tenant_id` clause is permitted in the service or route.

#### Scenario: tenant A import invisible to tenant B

- GIVEN tenant A (id `aaa...`) and tenant B (id `bbb...`) share the same Postgres instance
- WHEN `POST /contacts/import` is called with tenant A's header and one valid row (phone `"987654321"`)
- AND `GET /contacts` is called with tenant B's header
- THEN tenant B's response contains no contact with `phone_e164 = "+51987654321"`
- AND the contact exists and is queryable under tenant A

---

### Requirement: Summary Counts Are Consistent

`summary.total` MUST equal `contacts.length` (the number of rows in the request). The sum of `imported + resurrected + skippedInvalidPhone + skippedDuplicateInBatch + skippedAlreadyExists + errors` MUST equal `summary.total`. Every input row MUST appear in `rows` at its original `index`.

#### Scenario: mixed batch summary is consistent

- GIVEN a batch of 4 rows: one valid new, one invalid phone, one duplicate of first, one already-exists
- WHEN `POST /contacts/import` is called
- THEN `body.summary.total` is `4`
- AND `body.summary.imported + body.summary.resurrected + body.summary.skippedInvalidPhone + body.summary.skippedDuplicateInBatch + body.summary.skippedAlreadyExists + body.summary.errors` equals `4`
- AND `body.rows` has exactly 4 entries, each with a distinct `index` from `0` to `3`

---

## Out of Scope (Non-Requirements for This Slice)

- CSV/multipart file upload (deferred to a later slice requiring web UI).
- Async/background import via pg-boss (deferred for batches >500 rows).
- All-or-nothing transactional rollback (per-row best-effort is the intended UX).
- `bulkCreate(tx, rows[])` single-transaction bulk method (nested `withTenant` is unsupported by postgres.js).
- Set-based SQL bulk insert (deferred for >500 row scale).
- Web dashboard import UI.
- `WHERE tenant_id` in any query (RLS only, always).
