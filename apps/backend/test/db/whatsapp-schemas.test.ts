/**
 * whatsapp-schemas.test.ts — Type-level + runtime assertions for Drizzle WhatsApp schemas.
 *
 * Verifies that the Drizzle table definitions export the correct TypeScript types
 * and that the table/column names match the canonical DDL.
 *
 * Docker-free: no container needed. Pure schema shape assertions.
 */

import { describe, expect, it } from 'vitest';
import {
  type WhatsappAccount,
  whatsappAccountsTable,
} from '../../src/db/schema/whatsapp-accounts.schema.js';
import {
  type WhatsappMessage,
  whatsappMessagesTable,
} from '../../src/db/schema/whatsapp-messages.schema.js';

describe('whatsappAccountsTable — schema shape', () => {
  it('table name is whatsapp_accounts', () => {
    expect(whatsappAccountsTable[Symbol.for('drizzle:Name')]).toBe('whatsapp_accounts');
  });

  it('exports all required column keys', () => {
    const cols = Object.keys(whatsappAccountsTable);
    expect(cols).toContain('id');
    expect(cols).toContain('tenantId');
    expect(cols).toContain('phoneNumberId');
    expect(cols).toContain('displayPhoneNumber');
    expect(cols).toContain('wabaId');
    expect(cols).toContain('isActive');
    expect(cols).toContain('createdAt');
    expect(cols).toContain('updatedAt');
    expect(cols).toContain('deletedAt');
  });

  it('does NOT export app_secret or verify_token columns', () => {
    const cols = Object.keys(whatsappAccountsTable);
    expect(cols).not.toContain('appSecret');
    expect(cols).not.toContain('verifyToken');
  });

  it('WhatsappAccount type has the expected shape (runtime-level check via assignment)', () => {
    // If the type is wrong this will fail at compile time (tsc --noEmit).
    const sample: WhatsappAccount = {
      id: 'uuid',
      tenantId: 'uuid',
      phoneNumberId: '123',
      displayPhoneNumber: '+51987654321',
      wabaId: 'waba-123',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    expect(sample.id).toBe('uuid');
    expect(sample.deletedAt).toBeNull();
  });
});

describe('whatsappMessagesTable — schema shape', () => {
  it('table name is whatsapp_messages', () => {
    expect(whatsappMessagesTable[Symbol.for('drizzle:Name')]).toBe('whatsapp_messages');
  });

  it('exports all required column keys', () => {
    const cols = Object.keys(whatsappMessagesTable);
    expect(cols).toContain('id');
    expect(cols).toContain('tenantId');
    expect(cols).toContain('wamid');
    expect(cols).toContain('phoneNumberId');
    expect(cols).toContain('contactId');
    expect(cols).toContain('fromPhoneE164');
    expect(cols).toContain('messageType');
    expect(cols).toContain('textBody');
    expect(cols).toContain('rawPayload');
    expect(cols).toContain('receivedAt');
    expect(cols).toContain('createdAt');
  });

  it('does NOT export direction column', () => {
    const cols = Object.keys(whatsappMessagesTable);
    expect(cols).not.toContain('direction');
  });

  it('WhatsappMessage type has the expected shape (compile-time guard)', () => {
    const sample: WhatsappMessage = {
      id: 'uuid',
      tenantId: 'uuid',
      wamid: 'wamid_001',
      phoneNumberId: '111',
      contactId: 'contact-uuid',
      fromPhoneE164: '+51987654321',
      messageType: 'text',
      textBody: 'Hello',
      rawPayload: { key: 'value' },
      receivedAt: new Date(),
      createdAt: new Date(),
    };
    expect(sample.wamid).toBe('wamid_001');
    expect(sample.contactId).toBe('contact-uuid');
  });
});
