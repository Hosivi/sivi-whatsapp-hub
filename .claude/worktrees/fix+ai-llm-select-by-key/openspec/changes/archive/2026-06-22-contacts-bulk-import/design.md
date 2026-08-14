# Design — contacts-bulk-import

> SDD phase: design · Project: sivi-whatsapp-hub · Artifact store: hybrid (engram topic_key `sdd/contacts-bulk-import/design` + this file)
> Depends on: `sdd/contacts-bulk-import/proposal` (the 6 fixed decisions D1–D6)
> Scope: the implementation-level HOW. The architectural WHAT is FIXED by the proposal. This design pins file layout, the pure service signature, the per-row pipeline, the imported-vs-resurrected mechanism, the route wiring, and the test strategy.

---

## 1. Architecture approach

**Pattern: pure orchestration service over a repository PORT, composed at the HTTP edge.**

The slice adds exactly one new behavior — bulk ingestion — by COMPOSING primitives that already exist (`normalizePhoneE164`, `detectPhoneDuplicates`, `repo.create` with its read-then-branch resurrect + 23505 catch, `withTenant` RLS, `Result<T,E>`). It introduces NO new persistence path, NO new SQL, NO schema change, NO transaction primitive.

Layering (unchanged from the existing contacts module):

```
HTTP edge          contacts.route.ts   →  Zod validation, build repo from c.get('tenantId'), call service, shape 200 body
                          │
Application/domain contacts.import.ts  →  importContacts(repo, rows): pure orchestration, DB-independent
                          │
Infra port         ContactsRepository  →  repo.create(input) (REUSED UNCHANGED — one withTenant tx per call)
                          │
DB                 withTenant + RLS    →  Postgres, partial unique index, soft-delete resurrect
```

**Boundary discipline that makes the service unit-testable with zero DB:** the service depends ONLY on the `ContactsRepository` type (the port), never on `withTenant`, `db`, Drizzle, or Postgres. It receives an already-bound repo (bound to one tenant) and calls `repo.create` per row. This is functional DI: the dependency is a value passed in, not constructed inside.

---

## 2. The non-negotiable structural rules (and how the design enforces them)

| Rule | Enforcement in this design |
|------|----------------------------|
| Result<T,E> in domain, never throw | Service returns `Promise<ImportReport>` (always resolves; per-row failures are data, not exceptions). It reads `repo.create`'s `Result` and maps it. The ONLY non-recoverable case (`DB_ERROR`) is surfaced as an error outcome the route turns into 500 — see §5. |
| Throw only at infra | The service never throws. The route's JSON-parse guard mirrors the existing handlers (catch → 400). Any real throw originates inside `repo.create`/Postgres and is caught by Hono `onError`. |
| NO `WHERE tenant_id` | The service issues NO SQL at all. All tenant scoping is inherited from `repo.create` → `withTenant` → RLS. |
| Functional DI (no container/class) | `importContacts` is a plain async function taking the repo as its first argument. The route builds the repo per-request via the existing `createContactsRepository(deps.db.withTenant, tenantId)` factory. |
| NO nested `withTenant` | The service NEVER wraps the per-row loop in `withTenant`. It has no access to `withTenant` (only the repo port), so there is structurally nowhere to nest. Each `repo.create` opens and closes its OWN tx. This is the central reason the service takes a port, not a db handle. |
| create() reused UNCHANGED | The imported-vs-resurrected distinction is computed at the SERVICE level from the returned `Contact`'s timestamps (§4). `create()`, the `ContactError` union, the schema, and all existing callers/tests are untouched. |

---

## 3. File layout (NodeNext — `.js` import suffixes)

| File | Status | Contents |
|------|--------|----------|
| `apps/backend/src/contacts/contacts.import.ts` | NEW | `ImportRow`, `RowOutcome` union, `ImportSummary`, `ImportReport` types; the pure `importContacts(repo, rows)` service. |
| `apps/backend/src/contacts/contacts.route.ts` | MODIFIED | Add `importBodySchema` (Zod) + `POST /contacts/import` handler INLINE. No new route file. |
| `apps/backend/test/contacts/contacts.import.test.ts` | NEW | Docker-free UNIT test of `importContacts` against a FAKE in-memory repo. Covers every outcome + ordering + summary counts. |
| `apps/backend/test/contacts/contacts.import.int.test.ts` | NEW | Testcontainers (as `app_rls`) INTEGRATION test of `POST /contacts/import` through `buildApp` — real DB outcomes incl. resurrect + tenant isolation. |

Imports use explicit `.js` suffixes (NodeNext), matching the rest of the module (e.g. `from './phone-e164.js'`, `from '../shared/result.js'`).

NOTE on test filename: the proposal §6 names the unit test `contacts.import.test.ts` (Docker-free) and the integration test `contacts.import.int.test.ts`. The brief's `.int` mention for the unit test is reconciled to the proposal: unit = `contacts.import.test.ts`, integration = `contacts.import.int.test.ts`. The `.int.test.ts` suffix is the project's Testcontainers marker (see existing `*.int.test.ts` files); the plain `.test.ts` is Docker-free.

---

## 4. The imported-vs-resurrected mechanism (the one real subtlety)

**Problem.** D3 requires `resurrected` to be a DISTINCT outcome with its own count, BUT `repo.create` returns a `Contact` on BOTH the fresh-INSERT path (step 5) and the resurrect path (step 4) with no signal of which branch ran. The proposal FIXES `create()` as "reused unchanged" (§5, §7) — so we MUST NOT change its return type, and MUST NOT add a port method or a pre-check round-trip.

**Decision — timestamp comparison on the returned `Contact`. The service computes:**

```ts
const resurrected = contact.createdAt.getTime() < contact.updatedAt.getTime();
```

`imported` when `createdAt === updatedAt`; `resurrected` when `createdAt < updatedAt`.

**Why this is deterministic in THIS codebase (not a fragile heuristic):**

- Fresh INSERT (`repository.ts` step 5, lines 150–162): the INSERT supplies NEITHER `createdAt` NOR `updatedAt`. Both columns default to `sql\`now()\`` (`contacts.schema.ts` lines 53–58). Postgres evaluates `now()` ONCE per statement (statement-timestamp semantics), so on a fresh insert `created_at === updated_at` to the microsecond, by construction. → `resurrected === false`.
- Resurrect (`repository.ts` step 4, lines 124–139): the UPDATE sets `updatedAt: new Date()` and clears `deletedAt`, but NEVER touches `createdAt`. `createdAt` retains the ORIGINAL creation time, which belongs to a STRICTLY EARLIER transaction than the resurrect. Therefore `created_at < updated_at` always holds on a resurrect. → `resurrected === true`.

**Edge cases ruled out:**
- "Same-instant resurrect" (createdAt === updatedAt after a resurrect) is IMPOSSIBLE: the row must have been created and soft-deleted in earlier transactions before it can be resurrected, so its `createdAt` is strictly older than the resurrect's `updatedAt`.
- Clock-skew between DB `now()` (fresh insert) and JS `new Date()` (resurrect) does NOT affect correctness: the fresh-insert comparison uses TWO DB values from the SAME statement (always equal); the resurrect comparison contrasts an OLD DB value against a NEW JS value where the gap is at least one transaction round-trip (always positive). The two paths never compare a DB value against a JS value within the same row event.

**Why NOT change `create()` to return `{ contact, resurrected }`:** that is the theoretically cleanest source of truth, but it (a) directly violates the proposal's fixed "create() unchanged / no change to create()" constraint, and (b) breaks `contacts.route.ts:111` (`c.json(result.value, 201)` would serialize the wrapper instead of the Contact) plus every existing test reading `result.value.id`. The timestamp mechanism achieves the same outcome with ZERO blast radius. This is recorded as ADR-001 below; if a future slice ever needs create() to signal its branch for other reasons, ADR-001 documents the migration.

The FAKE repo in the unit test reproduces this contract: its `create` returns a Contact with `createdAt === updatedAt` for a new phone, and (for the resurrect scenario) a Contact with `createdAt < updatedAt` for a phone it was pre-seeded as soft-deleted. This keeps the unit test honest about the exact signal the production service reads.

---

## 5. The per-row pipeline (deterministic, index-preserving)

`importContacts(repo, rows)` iterates `rows` by ORIGINAL index `i` (0-based; preserved end-to-end into `report.rows[i].index`). For each row, in order:

```
for i in 0..rows.length-1:
  (a) NORMALIZE
      n = normalizePhoneE164(rows[i].phone)
      if n is err:
        outcome = skipped-invalid-phone { reason: n.error.code }   // EMPTY_INPUT | INVALID_FORMAT
        continue

  (b) IN-BATCH DEDUP  (JS, BEFORE any DB hit)
      if seenPhones.has(n.value):
        outcome = skipped-duplicate-in-batch { canonicalRowIndex: firstIndexOf[n.value] }
        continue
      seenPhones.add(n.value); firstIndexOf[n.value] = i

  (c) PERSIST
      r = await repo.create(rows[i])          // one withTenant tx; re-normalizes internally (idempotent)
      if r is ok:
        resurrected = r.value.createdAt < r.value.updatedAt
        outcome = resurrected
          ? resurrected { contactId: r.value.id }
          : imported    { contactId: r.value.id }
      else switch r.error.code:
        CONTACT_ALREADY_EXISTS → skipped-already-exists
        INVALID_PHONE          → skipped-invalid-phone { reason: 'INVALID_FORMAT' }   // defensive; (a) already filters
        DB_ERROR               → error { code: 'DB_ERROR' }   // see DB_ERROR policy below
```

**In-batch dedup mechanism — running Set + first-index map (CHOSEN over `detectPhoneDuplicates`).**

The proposal (D2, §4) offered two equivalent options; this design picks the **running `Set<string>` keyed by normalized phone, plus a `Map<string, number>` of first-occurrence index**. Justification:
- It keeps index order trivially: the Set is populated as we walk in original order, so the FIRST valid occurrence of a phone is the one that reaches the DB and the rest are marked `skipped-duplicate-in-batch` with `canonicalRowIndex` pointing at that first occurrence. No second pass, no index reconciliation.
- `detectPhoneDuplicates` operates on a fully-materialized array of normalized phones and returns groups; mapping its group indexes back onto the original mixed stream of valid/invalid rows requires a parallel index, which is exactly the "row-index drift" risk the proposal flags (§8). The running-Set avoids that drift class entirely.
- `detectPhoneDuplicates` stays available and is still exercised by its own existing unit tests; we simply don't route bulk-import dedup through it. (One-line note for reviewers: this is a deliberate divergence from the literal "feed detectPhoneDuplicates" phrasing in the proposal's reuse note — the proposal explicitly authorized either path and named the running-Set as the index-trivial one.)

**Determinism guarantees:**
- A normalized phone is claimed by the FIRST valid (a)-passing row only; invalid rows never claim a phone.
- `skipped-duplicate-in-batch` is decided BEFORE the DB, so a within-batch duplicate never causes a redundant `repo.create` round-trip.
- A live DB conflict that is NOT a within-batch duplicate (i.e. the phone already exists in the DB from a prior request) surfaces as `skipped-already-exists` from (c), distinct from `skipped-duplicate-in-batch`.

**DB_ERROR policy — per-row error outcome, route maps the WHOLE request to 500 if ANY row errored.**

D4 says "Only DB_ERROR → 500". To honor both best-effort-per-row AND that statement, the design splits responsibility:
- The SERVICE records a per-row `error` outcome (`{ status: 'error', code: 'DB_ERROR' }`) for any row whose `repo.create` returned `err(DB_ERROR)`, and KEEPS PROCESSING remaining rows (so the report is complete and the operator sees exactly which rows failed). It does NOT throw.
- The ROUTE inspects the finished report: if `report.summary.errors > 0`, it returns HTTP 500 with the report body (so the client both sees the 500 and gets the per-row detail); otherwise 200.

Rationale: a `DB_ERROR` is an infrastructure failure, not a domain outcome the caller can act on per-row, so the transport-level signal must be 500 (per D4). But discarding the whole report on the first DB_ERROR would hide which rows DID land; returning the report alongside the 500 preserves observability without violating "DB_ERROR → 500". `errors` is tracked in the summary specifically so the route has a single cheap predicate to branch on. If the spec later forbids a body on 500, the fallback is a bare 500 — the service contract is unchanged either way.

---

## 6. Types (contacts.import.ts)

```ts
import type { ContactsRepository, NewContactInput } from './contacts.repository.js';
import type { PhoneNormalizationErrorCode } from './phone-e164.js';

// One submitted row. Mirrors NewContactInput so repo.create accepts it directly.
export type ImportRow = NewContactInput;   // { phone; fullName?; source?; tags?; intent?; intentConfidence? }

export type RowOutcome =
  | { readonly index: number; readonly input: ImportRow; readonly status: 'imported';                 readonly contactId: string }
  | { readonly index: number; readonly input: ImportRow; readonly status: 'resurrected';              readonly contactId: string }
  | { readonly index: number; readonly input: ImportRow; readonly status: 'skipped-invalid-phone';    readonly reason: PhoneNormalizationErrorCode }
  | { readonly index: number; readonly input: ImportRow; readonly status: 'skipped-duplicate-in-batch'; readonly canonicalRowIndex: number }
  | { readonly index: number; readonly input: ImportRow; readonly status: 'skipped-already-exists' }
  | { readonly index: number; readonly input: ImportRow; readonly status: 'error';                    readonly code: 'DB_ERROR' };

export type ImportSummary = {
  readonly total: number;
  readonly imported: number;
  readonly resurrected: number;
  readonly skippedInvalidPhone: number;
  readonly skippedDuplicateInBatch: number;
  readonly skippedAlreadyExists: number;
  readonly errors: number;
};

export type ImportReport = {
  readonly summary: ImportSummary;
  readonly rows: ReadonlyArray<RowOutcome>;
};

export const importContacts = (
  repo: ContactsRepository,
  rows: ReadonlyArray<ImportRow>,
): Promise<ImportReport> => { /* §5 pipeline */ };
```

Notes:
- `ImportRow = NewContactInput` so `repo.create(rows[i])` typechecks with no adapter. The Zod `importRowSchema` produces exactly this shape.
- `reason` reuses `PhoneNormalizationErrorCode` (`'EMPTY_INPUT' | 'INVALID_FORMAT'`) — the same codes `normalizePhoneE164` already returns; no new error vocabulary.
- `summary` counts are derived by tallying `rows` once after the loop (single source of truth — counts can never drift from the row list).
- The function is `async` (awaits `repo.create`) but pure w.r.t. its inputs: same `rows` + same repo behavior → same report.

---

## 7. Route wiring (contacts.route.ts — INLINE)

Add ONE Zod schema + ONE handler. Mirrors the existing `POST /` handler's structure exactly.

```ts
// Reuse the existing per-row body shape; the import row schema IS createBodySchema.
const importRowSchema = createBodySchema;                       // already defined in this file
const importBodySchema = z.object({
  contacts: z.array(importRowSchema).min(1).max(200),
});

// POST /import — bulk import
router.post('/import', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400); }

  const parsed = importBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.issues }, 400);
  }

  const tenantId = c.get('tenantId');
  const repo = createContactsRepository(deps.db.withTenant, tenantId);
  const report = await importContacts(repo, parsed.data.contacts);

  const status = report.summary.errors > 0 ? 500 : 200;
  return c.json(report, status);
});
```

Route-level rules honored:
- Built per-request from `c.get('tenantId')` exactly like the other handlers — same tenant flow, same RLS path.
- Batch validation failures (empty array, >200, malformed row, bad JSON) → 400 `VALIDATION_ERROR` BEFORE any processing (D6). Per-row semantic phone validity is NOT a Zod concern (an invalid mobile becomes `skipped-invalid-phone` inside the 200 report).
- Reuses `createBodySchema` for the row shape → single source of truth with single-create; no schema drift between `POST /` and `POST /import`.
- ROUTE ORDERING: `POST /import` is a STATIC path and is registered ALONGSIDE the other static routes. There is no `POST /:something` collision (the existing dynamic POST is `POST /` only), so Hono matches `/import` literally. (GET/PATCH/DELETE use `/:id` but those are different methods — no conflict.)

---

## 8. Test strategy (Strict TDD)

**Unit — `contacts.import.test.ts` (Docker-free, FAKE in-memory repo).** Drives the pipeline and outcome mapping with zero DB. The fake repo:
- holds an in-memory `Map<phoneE164, { live | softDeleted }>` seeded per test;
- `create(input)` re-normalizes via `normalizePhoneE164` (to mirror production), then:
  - invalid phone → `err(INVALID_PHONE)`;
  - live phone present → `err(CONTACT_ALREADY_EXISTS)`;
  - soft-deleted phone present → `ok(Contact)` with `createdAt < updatedAt` (resurrect signal);
  - absent → `ok(Contact)` with `createdAt === updatedAt` (fresh-insert signal);
  - a configurable phone → `err(DB_ERROR)` for the error-path test.

Unit cases (each asserts both `summary` counts AND per-row `status`/extras at the right `index`):
1. all-new → all `imported`, counts correct, order preserved.
2. invalid phone (empty + malformed) → `skipped-invalid-phone` with `reason` `EMPTY_INPUT` / `INVALID_FORMAT`; valid rows around it still `imported` at correct indexes.
3. within-batch duplicate → first occurrence `imported`, later occurrences `skipped-duplicate-in-batch` with `canonicalRowIndex` = first index; only ONE `create` call for that phone (assert via fake call-count).
4. existing live phone → `skipped-already-exists`.
5. soft-deleted phone → `resurrected` with `contactId`, counted in `resurrected` not `imported`.
6. DB_ERROR phone → row `status: 'error'`, `summary.errors === 1`, remaining rows still processed.
7. mixed batch covering all six outcomes in one call → full summary tally + ordered rows.

**Integration — `contacts.import.int.test.ts` (Testcontainers, as `app_rls`, through `buildApp`).** Exercises the REAL DB so the timestamp-based resurrect signal is validated against actual Postgres `now()` vs app `new Date()` behavior — the part the fake cannot prove.

Container/setup pattern (matches existing int tests): ONE `createTestDb()` shared across the describe blocks in THIS file (`beforeAll` create, `afterAll` teardown, `beforeEach` truncate). Build `app = buildApp({ db, env })` once.

Integration cases:
1. happy path: 3 valid new rows → 200, `summary.imported === 3`, each row `imported` + a real `contactId`; GET /contacts confirms 3 rows.
2. within-batch duplicate of the SAME phone twice → 200, first `imported`, second `skipped-duplicate-in-batch` (canonicalRowIndex), DB has ONE row.
3. invalid Peru mobile in the batch → 200 (NOT 400), that row `skipped-invalid-phone`.
4. phone already live (seeded or created via prior request) → `skipped-already-exists`.
5. RESURRECT: create a contact, soft-delete it, then import the same phone → `resurrected`, same `id` as the original (assert id equality), `deletedAt` cleared; this is the case that proves `createdAt < updatedAt` truly distinguishes resurrect at the real DB layer.
6. batch validation: empty `contacts: []` → 400; 201-element array → 400.
7. TENANT ISOLATION: import for TENANT_A; a `POST /contacts/import` (or GET) as TENANT_B with the same phones imports them fresh (A's rows invisible) → proves RLS scoping through the bulk path; B sees only its own rows.

Reuse `createTestDb()`, `seedTenant`, `truncate`, `adminQuery` from `test/_helpers/test-db.ts`. No new helper needed.

---

## 9. ADR-style decisions

**ADR-001 — Distinguish imported vs resurrected by timestamp comparison, not by changing create().**
- Context: D3 needs `resurrected` as a distinct outcome; `create()` returns a `Contact` on both paths and is FIXED as unchanged by the proposal.
- Decision: service computes `resurrected = contact.createdAt < contact.updatedAt`.
- Rationale: fresh INSERT sets both timestamps to the SAME DB `now()` (schema defaults, single statement) → equal; resurrect updates only `updatedAt` against an older `createdAt` → strictly greater. Zero change to `create()`, zero new port surface, zero extra round-trip, no race.
- Rejected: (1) `create()` returns `{ contact, resurrected }` — cleanest source of truth but violates "create() unchanged" and breaks the single-create response body + all existing tests. (2) New port method `findByPhoneIncludingDeleted` pre-check — adds surface, an extra round-trip per row, and a TOCTOU race against concurrent resurrect.
- Consequence: the fake repo in the unit test MUST honor the same timestamp contract so the unit test exercises the real signal.

**ADR-002 — In-batch dedup via running Set + first-index map, not detectPhoneDuplicates.**
- Context: D2 authorizes either a running Set or `detectPhoneDuplicates`.
- Decision: running `Set<string>` over normalized phones + `Map<string, number>` first-index.
- Rationale: preserves original-row index trivially in a single forward pass, eliminating the row-index-drift risk (proposal §8) that mapping group indexes back over a mixed valid/invalid stream introduces.
- Rejected: `detectPhoneDuplicates` — fine for a pure-phone array but needs a parallel index to reattach to original rows here; not worth the drift surface. It remains used elsewhere with its own tests.

**ADR-003 — DB_ERROR becomes a per-row `error` outcome; route maps any error to 500 with the report body.**
- Context: D4 mandates "only DB_ERROR → 500" while the slice is best-effort per-row.
- Decision: service records `error` per failing row and continues; route returns 500 iff `summary.errors > 0`, otherwise 200, carrying the report in both cases.
- Rationale: keeps the report complete (operator sees which rows landed) while honoring the transport contract that a DB infra failure is a 500, not a per-row domain result. `summary.errors` gives the route a single predicate.
- Rejected: throw on first DB_ERROR (loses the partial report and which rows succeeded); silently swallow DB_ERROR into a "skipped" bucket (hides an infra failure as if it were a domain outcome).

**ADR-004 — POST /contacts/import inline; ImportRow = NewContactInput; row schema = createBodySchema.**
- Context: D5/D6 fix inline placement and Zod reuse.
- Decision: one handler + `importBodySchema` in `contacts.route.ts`; `ImportRow` aliases `NewContactInput`; `importRowSchema` aliases `createBodySchema`.
- Rationale: zero new plumbing, single source of truth for the row shape across single-create and bulk-import — the two endpoints can never drift.
- Rejected: separate route file (pure plumbing for a still-small file); a bespoke import row type/schema (invites drift).

---

## 10. Data flow (end to end)

```
HTTP POST /contacts/import { contacts: [...] }
  → tenant middleware sets c.var.tenantId (401/400 on missing/bad header)
  → JSON parse (catch → 400 VALIDATION_ERROR)
  → importBodySchema.safeParse  (fail → 400 VALIDATION_ERROR: empty / >200 / malformed)
  → repo = createContactsRepository(db.withTenant, tenantId)        // bound to ONE tenant
  → report = await importContacts(repo, contacts)                  // pure orchestration
        for each row (original index preserved):
          normalizePhoneE164 ── err ─→ skipped-invalid-phone(reason)
                              ── ok ──→ in-batch Set seen? ─ yes ─→ skipped-duplicate-in-batch(canonicalRowIndex)
                                                            ─ no  ─→ await repo.create(row)   // own withTenant tx (RLS)
                                                                       ok  → createdAt<updatedAt ? resurrected : imported (+contactId)
                                                                       err → ALREADY_EXISTS → skipped-already-exists
                                                                             INVALID_PHONE   → skipped-invalid-phone
                                                                             DB_ERROR        → error(DB_ERROR)
        tally summary from rows
  → status = summary.errors>0 ? 500 : 200
  → c.json(report, status)
```

---

## 11. Risks (design-level)

- **Resurrect-signal coupling to timestamp behavior (Med).** The mechanism relies on (a) fresh INSERT leaving createdAt===updatedAt and (b) resurrect bumping only updatedAt. Both are TRUE today and asserted by ADR-001's reasoning; the integration resurrect case (id-equality + cleared deletedAt) is the guard that catches any future regression where create() starts touching updatedAt on insert. Mitigation: keep that integration assertion; if create() ever sets updatedAt explicitly on insert, this design breaks loudly via that test.
- **Proposal's literal "feed detectPhoneDuplicates" wording (Low).** ADR-002 deliberately uses the running-Set path the proposal also authorized; reviewers should read ADR-002, not assume detectPhoneDuplicates is wired in.
- **500-with-body on DB_ERROR (Low).** If the spec mandates a bare 500 body, ADR-003's fallback (bare 500) applies with no service change. Flag for the spec phase to confirm the 500 body shape.
- **Per-row latency at 200 rows (Low).** 200 sequential `withTenant` round-trips is acceptable per D1; set-based is deferred to >500. No change.

---

## 12. Next recommended
sdd-tasks (spec is also expected as a parallel input; tasks should cover both this design and the spec scenarios).
