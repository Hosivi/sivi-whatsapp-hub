/**
 * contacts.tags.errors.ts — TagsError discriminated union.
 *
 * Kept separate from ContactError (ADR-2: dedicated error union + dedicated
 * HTTP status mapper — the switch stays exhaustive over exactly these codes).
 *
 * Domain logic never throws these — always returned via err(...).
 *
 * Codes:
 *   CONTACT_NOT_FOUND — no live contact with that id (or RLS-scoped out)
 *   INVALID_TAGS      — business-rule validation failure (empty, >60 chars, >50 count)
 *   DB_ERROR          — unexpected database-layer error (infra catch-all)
 */

export type TagsError =
  | { readonly code: 'CONTACT_NOT_FOUND' }
  | { readonly code: 'INVALID_TAGS'; readonly message: string }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };
