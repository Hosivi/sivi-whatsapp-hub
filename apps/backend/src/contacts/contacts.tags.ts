/**
 * contacts.tags.ts — Domain service for contact tag operations.
 *
 * Both functions delegate writes to repo.update() which already handles:
 *   - RLS tenant scoping via withTenant (no WHERE tenant_id)
 *   - Live-contact existence check → CONTACT_NOT_FOUND
 *   - updatedAt touch
 *
 * Business-rule validation lives here (→ INVALID_TAGS / 422).
 * Zod handles structure only (→ 400). Do NOT move these checks into Zod.
 *
 * Normalization order for replaceTags:
 *   1. trim each tag
 *   2. reject if any trimmed tag is empty/whitespace-only (INVALID_TAGS)
 *   3. deduplicate case-sensitive, first-occurrence wins
 *   4. reject if any tag exceeds 60 chars (INVALID_TAGS)
 *   5. reject if final count exceeds 50 (INVALID_TAGS)
 *   6. repo.update()
 */

import type { Contact } from '../db/schema/contacts.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type { ContactsRepository } from './contacts.repository.js';
import type { TagsError } from './contacts.tags.errors.js';

const MAX_TAG_LENGTH = 60;
const MAX_TAG_COUNT = 50;

// ---------------------------------------------------------------------------
// replaceTags — replace the full tag set for a contact
// ---------------------------------------------------------------------------

export async function replaceTags(
  repo: ContactsRepository,
  id: string,
  tags: string[],
): Promise<Result<Contact, TagsError>> {
  // 1. Trim each tag
  const trimmed = tags.map((t) => t.trim());

  // 2. Reject if any tag is empty/whitespace-only after trimming
  const hasEmpty = trimmed.some((t) => t.length === 0);
  if (hasEmpty) {
    return err({ code: 'INVALID_TAGS', message: 'Tags must not be empty or whitespace-only' });
  }

  // 3. Deduplicate case-sensitive, first-occurrence wins
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const tag of trimmed) {
    if (!seen.has(tag)) {
      seen.add(tag);
      deduped.push(tag);
    }
  }

  // 4. Reject if any tag exceeds 60 characters
  const hasTooLong = deduped.some((t) => t.length > MAX_TAG_LENGTH);
  if (hasTooLong) {
    return err({
      code: 'INVALID_TAGS',
      message: `Tags must not exceed ${MAX_TAG_LENGTH} characters`,
    });
  }

  // 5. Reject if final count exceeds 50
  if (deduped.length > MAX_TAG_COUNT) {
    return err({
      code: 'INVALID_TAGS',
      message: `Tag count must not exceed ${MAX_TAG_COUNT}`,
    });
  }

  // 6. Delegate write to repo.update (RLS-scoped, existence-checked)
  const result = await repo.update(id, { tags: deduped });
  if (!result.ok) {
    const code = result.error.code;
    if (code === 'CONTACT_NOT_FOUND') {
      return err({ code: 'CONTACT_NOT_FOUND' });
    }
    return err({ code: 'DB_ERROR', cause: result.error });
  }

  return ok(result.value);
}

// ---------------------------------------------------------------------------
// removeTag — remove one tag from a contact's tag set (idempotent)
// ---------------------------------------------------------------------------

export async function removeTag(
  repo: ContactsRepository,
  id: string,
  tag: string,
): Promise<Result<Contact, TagsError>> {
  // Find the contact first — needed to read current tags
  const found = await repo.findById(id);
  if (!found.ok) {
    const code = found.error.code;
    if (code === 'CONTACT_NOT_FOUND') {
      return err({ code: 'CONTACT_NOT_FOUND' });
    }
    return err({ code: 'DB_ERROR', cause: found.error });
  }

  const contact = found.value;

  // Filter out the tag (exact match); idempotent if absent — no write needed
  const filtered = contact.tags.filter((t) => t !== tag);

  // If nothing changed, return the current contact unchanged (no-op)
  if (filtered.length === contact.tags.length) {
    return ok(contact);
  }

  // Write the updated tag set
  const result = await repo.update(id, { tags: filtered });
  if (!result.ok) {
    const code = result.error.code;
    if (code === 'CONTACT_NOT_FOUND') {
      return err({ code: 'CONTACT_NOT_FOUND' });
    }
    return err({ code: 'DB_ERROR', cause: result.error });
  }

  return ok(result.value);
}
