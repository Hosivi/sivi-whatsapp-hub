/**
 * contacts.errors.ts — ContactError discriminated union.
 *
 * These are domain-level errors returned via Result<T, ContactError>.
 * Nothing in the contacts module throws these — they are always wrapped in err().
 *
 * Codes:
 *   CONTACT_NOT_FOUND      — no live contact with that id exists (findById, update, softDelete)
 *   CONTACT_ALREADY_EXISTS — phone is already in use by a live contact (create)
 *   INVALID_PHONE          — phone string failed E.164 normalization (create)
 *   DB_ERROR               — unexpected database-layer error (catch-all infra failure)
 */

export type ContactError =
  | { readonly code: 'CONTACT_NOT_FOUND' }
  | { readonly code: 'CONTACT_ALREADY_EXISTS' }
  | { readonly code: 'INVALID_PHONE' }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };
