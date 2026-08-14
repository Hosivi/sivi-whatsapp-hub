# Exploration — contact-phone-e164-dedupe

> SDD phase: explore · Project: sivi-whatsapp-hub · Artifact store: hybrid (engram topic_key `sdd/contact-phone-e164-dedupe/explore`)

## Scope of the change (intentionally minimal)

A pure domain function (or small set) that:
1. Normalizes a phone string to E.164 (Peru: `+51` + 9-digit mobile).
2. Detects/deduplicates contacts by their normalized `phone_e164`.

Hard rules: no `throw` in domain logic → `Result<T, E>`; unit-tested with Vitest (Strict TDD); no DB, no RLS, no HTTP.

## Key findings

### 1. Domain code location
No established domain structure beyond `src/core/health/`. Natural home for this slice:

```
apps/backend/src/contacts/phone-e164.ts          ← normalizer + dedupe
apps/backend/src/shared/result.ts                ← Result<T,E> (FIRST introduction)
apps/backend/test/contacts/phone-e164.test.ts    ← Vitest tests (mirrors test/ convention)
```
Files/dirs in kebab-case confirmed (`health.route.ts`, `contact-lead.ts`).

### 2. `Result<T,E>` does NOT exist in source
Referenced only in `Docs/specs/` and `CLAUDE.md`, never implemented. **This change introduces it for the first time** — a cross-cutting foundational decision.

### 3. `ContactLead` / `phone_e164`
`packages/contracts/src/contact-lead.ts` → `phone_e164: z.string()` with NO regex refinement. The normalizer output feeds this field. Tightening to `.regex(/^\+51\d{9}$/)` is a follow-up, out of this slice. `@sivihub/contracts` is already a dependency of `apps/backend`.

### 4. Vitest conventions
- Root `vitest.config.ts`: `include: ['tests/**/*.test.ts']` (root smoke only).
- Backend `package.json`: `"test": "vitest run"` → discovers all `*.test.ts` recursively.
- Existing test: `apps/backend/test/health.test.ts` (separate `test/` dir).
- Imports: `describe/it/expect` from `'vitest'`; `.js` extension on internal imports (NodeNext).

### 5. TypeScript config
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`. Result constructors and error types must be fully typed.

### 6. No phone library
No `libphonenumber-js` anywhere in the monorepo.

## Approach options

| Approach | Pros | Cons | Recommendation |
|---|---|---|---|
| `libphonenumber-js` | Global edge cases, mobile-type validation, robust | ~25KB dep; overkill for Peru-only; tests exercise the lib, not our domain; mismatched to "minimal TDD slice" | No (defer to Corte 1+ via ADR) |
| **Hand-rolled Peru normalizer** | Zero deps; 100% of logic under our tests; explicit Peru rules; minimal | Peru-only, not i18n-ready | **YES** |

Inputs to handle: `+51987654321`, `51987654321`, `987654321`, `+51 987 654 321`, `(+51) 987-654-321`.
Algorithm: strip non-digits → handle `51` prefix → verify 9 digits → prepend `+51`; else `Err`.

## Open questions for the proposal
1. **`Result<T,E>` placement**: `apps/backend/src/shared/result.ts` (local, recommended) vs. new `packages/core`.
2. **`Result<T,E>` shape**: discriminated union — `{ ok: true; value: T } | { ok: false; error: E }` vs. `type: 'ok'|'err'`. Canonical for the whole project.
3. **Error codes**: minimal `INVALID_FORMAT` + `EMPTY_INPUT`; optional `WRONG_COUNTRY`.
4. **Test location**: `test/` subdirectory (existing convention) vs. co-located.
5. **`contactLeadSchema` refinement**: tighten `phone_e164` now or defer (recommend defer).

## Risks
1. `Result<T,E>` shape is project-wide — get it right now or face a refactor later.
2. `contactLeadSchema` has no E.164 validation post-change (follow-up, non-blocking).
3. No `apps/backend/vitest.config.ts` — relies on defaults (low risk now).

## Next recommended
`sdd-propose`
