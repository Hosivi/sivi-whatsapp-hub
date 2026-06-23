/**
 * contacts.routing.map.test.ts — Unit tests for mapContactToContactLead.
 *
 * Docker-free: pure function, no I/O, no database.
 * The mapper is a total function — caller (service) guarantees fullName is non-null.
 *
 * These tests are the ADR-4 contract guard: they validate the mapper output against
 * contactLeadSchema so the service can store the result directly without a runtime parse.
 */

import { contactLeadSchema } from '@sivihub/contracts';
import { describe, expect, it } from 'vitest';
import { mapContactToContactLead } from '../../src/contacts/contacts.routing.js';
import type { Contact } from '../../src/db/schema/contacts.schema.js';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * Build a fully-populated Contact domain object (post-mapRowToContact).
 * fullName is non-null here — the service enforces the quality gate before calling
 * the mapper, so unit tests only cover the non-null case per ADR-7.
 */
function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    tenantId: TENANT_ID,
    phoneE164: '+51987654321',
    fullName: 'Ana García',
    source: 'web',
    tags: ['vip', 'premium'],
    intent: 'buy',
    intentConfidence: 0.9,
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    updatedAt: new Date('2026-01-15T10:00:00.000Z'),
    deletedAt: null,
    routedAt: null,
    ...overrides,
  };
}

describe('mapContactToContactLead', () => {
  it('maps all fields correctly for a fully-populated contact', () => {
    const contact = makeContact();
    const lead = mapContactToContactLead(contact, TENANT_ID);

    expect(lead.external_id).toBe(contact.id);
    expect(lead.phone_e164).toBe(contact.phoneE164);
    expect(lead.full_name).toBe('Ana García');
    expect(lead.source).toBe('whatsapp');
    expect(lead.intent).toBe('buy');
    expect(lead.intent_confidence).toBe(0.9);
    expect(lead.tags).toEqual(['vip', 'premium']);
    expect(lead.form_payload).toBeUndefined();
    expect(lead.captured_at).toBe(contact.createdAt.toISOString());
    expect(lead.tenant_id).toBe(TENANT_ID);
  });

  it('output validates against contactLeadSchema (ADR-4 contract guard)', () => {
    const contact = makeContact();
    const lead = mapContactToContactLead(contact, TENANT_ID);
    const parsed = contactLeadSchema.safeParse(lead);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBe('whatsapp');
      expect(parsed.data.external_id).toBe(contact.id);
      expect(parsed.data.captured_at).toBe(contact.createdAt.toISOString());
    }
  });

  it('maps null intent and intentConfidence to undefined (not null)', () => {
    const contact = makeContact({ intent: null, intentConfidence: null });
    const lead = mapContactToContactLead(contact, TENANT_ID);

    // The mapper uses conditional spread so null fields are NOT present as keys.
    // Accessing a missing key returns undefined — both toBeUndefined() calls verify that.
    expect(lead.intent).toBeUndefined();
    expect(lead.intent_confidence).toBeUndefined();
    // Also verify they are not null (null would be a mapping error).
    expect(lead.intent).not.toBeNull();
    expect(lead.intent_confidence).not.toBeNull();
  });

  it('passes through an empty tags array as-is', () => {
    const contact = makeContact({ tags: [] });
    const lead = mapContactToContactLead(contact, TENANT_ID);

    expect(lead.tags).toEqual([]);
  });

  it('form_payload is always undefined regardless of input', () => {
    const contact = makeContact();
    const lead = mapContactToContactLead(contact, TENANT_ID);

    expect(lead.form_payload).toBeUndefined();
  });
});
