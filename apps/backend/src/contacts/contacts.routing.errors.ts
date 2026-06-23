/**
 * contacts.routing.errors.ts — ContactRoutingError discriminated union.
 *
 * Kept separate from ContactError to ensure the routing surface stays minimal
 * and the HTTP status mapper stays exhaustive over exactly these three codes.
 * (ADR-2: dedicated error union + dedicated status mapper.)
 *
 * Domain logic never throws these — always returned via err(...).
 * Only infrastructure failures (thrown DB errors) are caught and wrapped as DB_ERROR.
 */

export type ContactRoutingError =
  | { readonly code: 'CONTACT_NOT_FOUND' }
  | { readonly code: 'MISSING_FULL_NAME' }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };
