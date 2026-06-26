/**
 * contacts.intent.errors.ts — IntentError discriminated union.
 *
 * Kept separate from ContactError (ADR-2: dedicated error union + dedicated
 * HTTP status mapper — the switch stays exhaustive over exactly these codes).
 *
 * Domain logic never throws these — always returned via err(...).
 *
 * Codes:
 *   CONTACT_NOT_FOUND — no live contact with that id (or RLS-scoped out)
 *   INVALID_INTENT    — business-rule validation failure (empty, whitespace,
 *                        >120 chars, or confidence without intent)
 *   DB_ERROR          — unexpected database-layer error (infra catch-all)
 */

export type IntentError =
  | { readonly code: 'CONTACT_NOT_FOUND' }
  | { readonly code: 'INVALID_INTENT'; readonly message: string }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };
