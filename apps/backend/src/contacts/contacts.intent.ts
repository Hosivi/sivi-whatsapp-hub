/**
 * contacts.intent.ts — Domain service for contact intent operations.
 *
 * setIntent delegates writes to repo.update() which already handles:
 *   - RLS tenant scoping via withTenant (no WHERE tenant_id)
 *   - Live-contact existence check → CONTACT_NOT_FOUND
 *   - updatedAt touch
 *   - intentConfidence string coercion (Drizzle numeric column)
 *
 * Business-rule validation lives here (→ INVALID_INTENT / 422).
 * Zod handles structure only (→ 400). Do NOT move these checks into Zod.
 *
 * Rules for setIntent:
 *   1. If intent is null: clear BOTH intent and intentConfidence to null.
 *      Reject if intentConfidence is non-null (confidence without intent → INVALID_INTENT).
 *   2. If intent is a string: trim → reject if empty/whitespace-only (INVALID_INTENT)
 *      → reject if trimmed length > 120 (INVALID_INTENT) → repo.update with trimmed value.
 */

import type { Contact } from '../db/schema/contacts.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type { IntentError } from './contacts.intent.errors.js';
import type { ContactsRepository } from './contacts.repository.js';

const MAX_INTENT_LENGTH = 120;

// ---------------------------------------------------------------------------
// setIntent — set or clear a contact's intent and optional confidence score
// ---------------------------------------------------------------------------

export async function setIntent(
  repo: ContactsRepository,
  id: string,
  intent: string | null,
  intentConfidence?: number | null,
): Promise<Result<Contact, IntentError>> {
  if (intent === null) {
    // Clearing path — confidence with null intent is semantically invalid
    if (intentConfidence != null) {
      return err({
        code: 'INVALID_INTENT',
        message: 'intentConfidence requires a non-null intent',
      });
    }

    // Clear both fields
    const result = await repo.update(id, { intent: null, intentConfidence: null });
    if (!result.ok) {
      const code = result.error.code;
      if (code === 'CONTACT_NOT_FOUND') {
        return err({ code: 'CONTACT_NOT_FOUND' });
      }
      return err({ code: 'DB_ERROR', cause: result.error });
    }
    return ok(result.value);
  }

  // Setting path — trim then validate
  const trimmed = intent.trim();

  if (trimmed.length === 0) {
    return err({ code: 'INVALID_INTENT', message: 'Intent must not be empty or whitespace-only' });
  }

  if (trimmed.length > MAX_INTENT_LENGTH) {
    return err({
      code: 'INVALID_INTENT',
      message: `Intent must not exceed ${MAX_INTENT_LENGTH} characters`,
    });
  }

  // Delegate write to repo.update (RLS-scoped, existence-checked)
  const patch: { intent: string; intentConfidence?: number | null } = { intent: trimmed };
  if (intentConfidence !== undefined) {
    patch.intentConfidence = intentConfidence;
  }

  const result = await repo.update(id, patch);
  if (!result.ok) {
    const code = result.error.code;
    if (code === 'CONTACT_NOT_FOUND') {
      return err({ code: 'CONTACT_NOT_FOUND' });
    }
    return err({ code: 'DB_ERROR', cause: result.error });
  }

  return ok(result.value);
}
