/**
 * contacts.routing.ts — ContactLead routing: pure mapper + routing service.
 *
 * Two exports:
 *   mapContactToContactLead — pure, total, no I/O. Maps a Contact to a ContactLead.
 *   routeContact             — service; atomic read+branch+write in ONE withTenant tx.
 *
 * Design invariants:
 *   - The MISSING_FULL_NAME quality gate lives here in the service (ADR-7), not the mapper.
 *   - The mapper is total: caller guarantees fullName is non-null before calling it.
 *   - Atomicity: SELECT + UPDATE contacts + INSERT outbox all share the SAME tx (ADR-3).
 *   - Error propagation: pure Result branches return normally; the write block lets DB
 *     throws escape so the tx rolls back; an outer try/catch maps infra errors to DB_ERROR.
 *   - NO WHERE tenant_id — RLS enforces isolation via set_config (invariant from CLAUDE.md).
 */

import type { ContactLead } from '@sivihub/contracts';
import { eq } from 'drizzle-orm';
import type { TenantRunner } from '../db/client.js';
import { contactLeadOutboxTable } from '../db/schema/contact-lead-outbox.schema.js';
import { contactsTable, mapRowToContact } from '../db/schema/contacts.schema.js';
import type { Contact } from '../db/schema/contacts.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type { ContactRoutingError } from './contacts.routing.errors.js';

// ---------------------------------------------------------------------------
// Pure mapper — Contact + tenantId → ContactLead
// ---------------------------------------------------------------------------

/**
 * Maps a Contact domain object to a ContactLead contract payload.
 * Pure, total function — no I/O, no Result wrapper.
 *
 * PRECONDITION: contact.fullName is non-null.
 * The routeContact service enforces the MISSING_FULL_NAME gate BEFORE calling this.
 * If fullName were null here the produced lead would fail contactLeadSchema validation —
 * that is a programmer error, not a runtime branch (ADR-7).
 *
 * tenantId is passed explicitly rather than read from contact.tenantId so the mapper
 * does not depend on the schema carrying that column. At the call site they are always
 * identical (RLS guarantees the row's tenant_id equals the current tenant).
 */
export const mapContactToContactLead = (contact: Contact, tenantId: string): ContactLead => ({
  external_id: contact.id,
  phone_e164: contact.phoneE164,
  full_name: contact.fullName as string,
  source: 'whatsapp',
  ...(contact.intent != null ? { intent: contact.intent } : {}),
  ...(contact.intentConfidence != null ? { intent_confidence: contact.intentConfidence } : {}),
  tags: contact.tags,
  form_payload: undefined,
  captured_at: contact.createdAt.toISOString(),
  tenant_id: tenantId,
});

// ---------------------------------------------------------------------------
// Service — routeContact
// ---------------------------------------------------------------------------

/**
 * Routes a contact to the CRM by:
 *   1. Fetching the contact inside a withTenant tx (RLS-scoped; NO WHERE tenant_id).
 *   2. Branching: not-found → CONTACT_NOT_FOUND; already-routed → no-op ok;
 *      null full_name → MISSING_FULL_NAME; else → write path.
 *   3. Write path: UPDATE contacts.routed_at + INSERT outbox row — atomically in ONE tx.
 *
 * Atomicity design:
 *   - Pure validation branches (not-found, missing-full-name, already-routed) return Result
 *     values normally. These exit the tx cleanly with no writes.
 *   - The write block (UPDATE + INSERT) does NOT have a try/catch. If either DB op throws,
 *     the exception propagates out of the withTenant callback, which causes db.transaction()
 *     to ROLL BACK both writes (routed_at stays null, outbox row is not inserted).
 *   - An outer try/catch wraps the entire withTenant(...) call and maps any thrown infra
 *     error to err({ code: 'DB_ERROR', cause: e }).
 */
export const routeContact = (
  withTenant: TenantRunner,
  tenantId: string,
  contactId: string,
): Promise<Result<ContactLead, ContactRoutingError>> => {
  // Outer try/catch: catches anything that throws OUT of the withTenant callback
  // (DB infra errors that escaped the tx and rolled it back).
  return withTenant(tenantId, async (tx) => {
    // 1. Atomic read — RLS-scoped, NO WHERE tenant_id. Soft-deleted treated as not-found.
    const rows = await tx
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contactId))
      .limit(1);

    const row = rows[0];
    if (!row || row.deletedAt !== null) {
      return err({ code: 'CONTACT_NOT_FOUND' } as const);
    }

    // 2. Already routed → no-op: rebuild the lead, do NOT bump routed_at, do NOT insert again.
    if (row.routedAt !== null) {
      const contact = mapRowToContact(row);
      return ok(mapContactToContactLead(contact, tenantId));
    }

    // 3. Quality gate: contract requires full_name. Block dirty data at the frontier.
    if (row.fullName === null) {
      return err({ code: 'MISSING_FULL_NAME' } as const);
    }

    // 4. First-time route — set routed_at AND insert outbox row in THIS SAME tx (atomic).
    // DO NOT wrap in try/catch: if either write throws, the exception escapes to the outer
    // try/catch (outside withTenant), causing db.transaction() to roll back both writes.
    const contact = mapRowToContact(row);
    const lead = mapContactToContactLead(contact, tenantId);

    await tx
      .update(contactsTable)
      .set({ routedAt: new Date(), updatedAt: new Date() })
      .where(eq(contactsTable.id, contactId));

    await tx.insert(contactLeadOutboxTable).values({
      tenantId,
      contactId,
      payload: lead,
    });

    return ok(lead);
  }).catch((e: unknown) => {
    // Outer catch: maps infra errors that escaped (and rolled back) the tx to DB_ERROR.
    return err({ code: 'DB_ERROR', cause: e } as const);
  });
};
