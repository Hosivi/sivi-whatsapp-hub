/**
 * contacts.repository.ts — ContactsRepository factory.
 *
 * Key invariants:
 * - ALL database operations run inside withTenant(tenantId, ...) — no query ever
 *   reaches Postgres outside a tenant-pinned transaction.
 * - NO WHERE tenant_id anywhere — RLS handles tenant scoping entirely.
 * - NO raw db/sql handle — the factory receives only TenantRunner.
 * - adminSql never appears here.
 *
 * create() logic — explicit read-then-branch (NOT ON CONFLICT):
 *   1. normalizePhoneE164 → err → INVALID_PHONE (no DB hit)
 *   2. SELECT by normalized phone (incl. soft-deleted rows) inside withTenant
 *   3. row exists + live   → err(CONTACT_ALREADY_EXISTS)
 *   4. row exists + deleted → UPDATE SET deleted_at=NULL, ... RETURNING * (resurrect, same id)
 *   5. absent              → INSERT RETURNING * ; catch 23505 → err(CONTACT_ALREADY_EXISTS)
 *
 * softDelete() idempotency:
 *   SELECT id, deleted_at first:
 *   - absent      → err(CONTACT_NOT_FOUND)
 *   - already del → ok(undefined)
 *   - live        → UPDATE SET deleted_at=now() → ok(undefined)
 */

import { desc, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantRunner } from '../db/client.js';
import { contactsTable, mapRowToContact } from '../db/schema/contacts.schema.js';
import type { Contact } from '../db/schema/contacts.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type { ContactError } from './contacts.errors.js';
import { normalizePhoneE164 } from './phone-e164.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type NewContactInput = {
  readonly phone: string;
  readonly fullName?: string | null | undefined;
  readonly source?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly intent?: string | null | undefined;
  readonly intentConfidence?: number | null | undefined;
};

export type ContactPatch = {
  readonly fullName?: string | null | undefined;
  readonly source?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly intent?: string | null | undefined;
  readonly intentConfidence?: number | null | undefined;
};

export type ListOpts = {
  readonly limit?: number;
};

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export type ContactsRepository = {
  create(input: NewContactInput): Promise<Result<Contact, ContactError>>;
  findById(id: string): Promise<Result<Contact, ContactError>>;
  list(opts?: ListOpts): Promise<Result<Contact[], ContactError>>;
  update(id: string, patch: ContactPatch): Promise<Result<Contact, ContactError>>;
  softDelete(id: string): Promise<Result<void, ContactError>>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: unknown }).code === UNIQUE_VIOLATION
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createContactsRepository = (
  withTenant: TenantRunner,
  tenantId: string,
): ContactsRepository => {
  // ------------------------------------------------------------------
  // create
  // ------------------------------------------------------------------
  const create = async (input: NewContactInput): Promise<Result<Contact, ContactError>> => {
    // Step 1: normalize phone (no DB hit)
    const normalized = normalizePhoneE164(input.phone);
    if (!normalized.ok) {
      return err({ code: 'INVALID_PHONE' });
    }
    const phoneE164 = normalized.value;

    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      // Step 2: SELECT by normalized phone, including soft-deleted rows.
      // RLS scopes to current tenant — no WHERE tenant_id needed.
      const rows = await tx
        .select()
        .from(contactsTable)
        .where(eq(contactsTable.phoneE164, phoneE164))
        .limit(1);

      const existing = rows[0];

      // Step 3: live conflict
      if (existing && existing.deletedAt === null) {
        return err({ code: 'CONTACT_ALREADY_EXISTS' });
      }

      // Step 4: soft-deleted → resurrect same row (same id)
      if (existing && existing.deletedAt !== null) {
        const updated = await tx
          .update(contactsTable)
          .set({
            deletedAt: null,
            fullName: input.fullName ?? null,
            source: input.source ?? null,
            tags: input.tags ?? existing.tags,
            intent: input.intent ?? existing.intent,
            intentConfidence:
              input.intentConfidence !== undefined
                ? String(input.intentConfidence)
                : existing.intentConfidence,
            updatedAt: new Date(),
          })
          .where(eq(contactsTable.id, existing.id))
          .returning();

        const row = updated[0];
        if (!row) {
          return err({ code: 'DB_ERROR' });
        }
        return ok(mapRowToContact(row));
      }

      // Step 5: INSERT — catch unique violation for concurrent-create race
      try {
        const inserted = await tx
          .insert(contactsTable)
          .values({
            tenantId,
            phoneE164,
            fullName: input.fullName ?? null,
            source: input.source ?? null,
            tags: input.tags ?? [],
            intent: input.intent ?? null,
            intentConfidence:
              input.intentConfidence !== undefined ? String(input.intentConfidence) : null,
          })
          .returning();

        const row = inserted[0];
        if (!row) {
          return err({ code: 'DB_ERROR' });
        }
        return ok(mapRowToContact(row));
      } catch (e) {
        if (isUniqueViolation(e)) {
          return err({ code: 'CONTACT_ALREADY_EXISTS' });
        }
        return err({ code: 'DB_ERROR', cause: e });
      }
    });
  };

  // ------------------------------------------------------------------
  // findById
  // ------------------------------------------------------------------
  const findById = async (id: string): Promise<Result<Contact, ContactError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      const rows = await tx.select().from(contactsTable).where(eq(contactsTable.id, id)).limit(1);

      const row = rows[0];
      if (!row || row.deletedAt !== null) {
        return err({ code: 'CONTACT_NOT_FOUND' });
      }
      return ok(mapRowToContact(row));
    });
  };

  // ------------------------------------------------------------------
  // list
  // ------------------------------------------------------------------
  const list = async (_opts?: ListOpts): Promise<Result<Contact[], ContactError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      const rows = await tx
        .select()
        .from(contactsTable)
        .where(isNull(contactsTable.deletedAt))
        .orderBy(desc(contactsTable.createdAt));

      return ok(rows.map(mapRowToContact));
    });
  };

  // ------------------------------------------------------------------
  // update
  // ------------------------------------------------------------------
  const update = async (
    id: string,
    patch: ContactPatch,
  ): Promise<Result<Contact, ContactError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      // Must be a live contact
      const rows = await tx.select().from(contactsTable).where(eq(contactsTable.id, id)).limit(1);

      const existing = rows[0];
      if (!existing || existing.deletedAt !== null) {
        return err({ code: 'CONTACT_NOT_FOUND' });
      }

      const updated = await tx
        .update(contactsTable)
        .set({
          ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
          ...(patch.source !== undefined ? { source: patch.source } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          ...(patch.intent !== undefined ? { intent: patch.intent } : {}),
          ...(patch.intentConfidence !== undefined
            ? {
                intentConfidence:
                  patch.intentConfidence === null ? null : String(patch.intentConfidence),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(contactsTable.id, id))
        .returning();

      const row = updated[0];
      if (!row) {
        return err({ code: 'DB_ERROR' });
      }
      return ok(mapRowToContact(row));
    });
  };

  // ------------------------------------------------------------------
  // softDelete
  // ------------------------------------------------------------------
  const softDelete = async (id: string): Promise<Result<void, ContactError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      // Existence read to distinguish absent vs already-deleted (row count alone cannot)
      const rows = await tx
        .select({ id: contactsTable.id, deletedAt: contactsTable.deletedAt })
        .from(contactsTable)
        .where(eq(contactsTable.id, id))
        .limit(1);

      const row = rows[0];

      if (!row) {
        return err({ code: 'CONTACT_NOT_FOUND' });
      }

      // Idempotent: already deleted → ok without another UPDATE
      if (row.deletedAt !== null) {
        return ok(undefined);
      }

      await tx
        .update(contactsTable)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(contactsTable.id, id));

      return ok(undefined);
    });
  };

  return { create, findById, list, update, softDelete };
};
