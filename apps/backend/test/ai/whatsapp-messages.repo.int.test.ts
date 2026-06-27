/**
 * whatsapp-messages.repo.int.test.ts — Integration tests for getConversationHistory
 * and isWithin24hServiceWindow.
 *
 * All assertions run through the app_rls-scoped TenantRunner (RLS enforced).
 * Uses Testcontainers (postgres:16-alpine + all 5 migrations).
 *
 * Strict TDD: this file was written RED (before the implementation).
 * RED commit: functions imported do not exist yet → TS/import error at runtime.
 */

import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isWithin24hServiceWindow } from '../../src/ai/ai-reply.service.js';
import { getConversationHistory } from '../../src/whatsapp-messages/whatsapp-messages.repository.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONTACT_A1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONTACT_B1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a whatsapp_messages row directly via adminSql (bypasses RLS).
 * receivedAt accepts a Date — must be a real timestamp for ordering assertions.
 */
async function seedMessage(
  db: TestDb,
  params: {
    tenantId: string;
    contactId: string;
    wamid: string;
    direction: 'inbound' | 'outbound';
    textBody?: string | null;
    receivedAt: Date;
  },
): Promise<void> {
  await db.adminQuery(async (tx) => {
    await tx.execute(
      rawSql`
        INSERT INTO whatsapp_messages
          (tenant_id, wamid, phone_number_id, contact_id, from_phone_e164,
           message_type, text_body, raw_payload, received_at, direction)
        VALUES
          (${params.tenantId}::uuid, ${params.wamid}, 'pnid-test',
           ${params.contactId}::uuid, '+51999000001',
           'text', ${params.textBody ?? null}, '{}', ${params.receivedAt.toISOString()}::timestamptz,
           ${params.direction})
      `,
    );
  });
}

/**
 * Inserts a contacts row for the given tenant via adminSql (needed for FK).
 */
async function seedContact(
  db: TestDb,
  params: { tenantId: string; contactId: string; phoneE164: string },
): Promise<void> {
  await db.adminQuery(async (tx) => {
    await tx.execute(
      rawSql`
        INSERT INTO contacts (id, tenant_id, phone_e164)
        VALUES (${params.contactId}::uuid, ${params.tenantId}::uuid, ${params.phoneE164})
        ON CONFLICT DO NOTHING
      `,
    );
  });
}

// ---------------------------------------------------------------------------
// getConversationHistory
// ---------------------------------------------------------------------------

describe('getConversationHistory', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    // Seed FK-required contacts once (truncate resets, so we re-seed in beforeEach)
  });

  beforeEach(async () => {
    await db.truncate();
    await seedContact(db, { tenantId: TENANT_A, contactId: CONTACT_A1, phoneE164: '+51999000001' });
    await seedContact(db, { tenantId: TENANT_B, contactId: CONTACT_B1, phoneE164: '+51999000002' });
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('returns empty array when no messages exist for the contact', async () => {
    const result = await getConversationHistory(db.withTenant, TENANT_A, CONTACT_A1);
    expect(result).toEqual([]);
  });

  it('returns only inbound messages mapped to role:user (outbound dropped)', async () => {
    const t0 = new Date('2026-01-01T10:00:00Z');
    const t1 = new Date('2026-01-01T10:05:00Z');

    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-in-1',
      direction: 'inbound',
      textBody: 'hello',
      receivedAt: t0,
    });
    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-out-1',
      direction: 'outbound',
      textBody: 'hi back',
      receivedAt: t1,
    });

    const result = await getConversationHistory(db.withTenant, TENANT_A, CONTACT_A1);

    // Only the inbound message should be returned
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('returns messages in chronological order (oldest first)', async () => {
    const t0 = new Date('2026-01-01T10:00:00Z');
    const t1 = new Date('2026-01-01T10:10:00Z');
    const t2 = new Date('2026-01-01T10:20:00Z');

    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-in-1',
      direction: 'inbound',
      textBody: 'first',
      receivedAt: t0,
    });
    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-in-2',
      direction: 'inbound',
      textBody: 'second',
      receivedAt: t1,
    });
    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-in-3',
      direction: 'inbound',
      textBody: 'third',
      receivedAt: t2,
    });

    const result = await getConversationHistory(db.withTenant, TENANT_A, CONTACT_A1);

    expect(result).toHaveLength(3);
    expect(result[0]?.content).toBe('first');
    expect(result[1]?.content).toBe('second');
    expect(result[2]?.content).toBe('third');
  });

  it('caps at the default limit (10) when more messages exist', async () => {
    const base = new Date('2026-01-01T10:00:00Z');

    for (let i = 0; i < 15; i++) {
      await seedMessage(db, {
        tenantId: TENANT_A,
        contactId: CONTACT_A1,
        wamid: `wamid-in-${i}`,
        direction: 'inbound',
        textBody: `msg ${i}`,
        receivedAt: new Date(base.getTime() + i * 60_000),
      });
    }

    const result = await getConversationHistory(db.withTenant, TENANT_A, CONTACT_A1);
    expect(result).toHaveLength(10);
    // Should be the LATEST 10 messages (DESC LIMIT then reversed to chronological)
    expect(result[0]?.content).toBe('msg 5');
    expect(result[9]?.content).toBe('msg 14');
  });

  it('respects an explicit limit override', async () => {
    const base = new Date('2026-01-01T10:00:00Z');

    for (let i = 0; i < 5; i++) {
      await seedMessage(db, {
        tenantId: TENANT_A,
        contactId: CONTACT_A1,
        wamid: `wamid-in-lim-${i}`,
        direction: 'inbound',
        textBody: `msg ${i}`,
        receivedAt: new Date(base.getTime() + i * 60_000),
      });
    }

    const result = await getConversationHistory(db.withTenant, TENANT_A, CONTACT_A1, 3);
    expect(result).toHaveLength(3);
  });

  it('drops messages with null text_body', async () => {
    const t0 = new Date('2026-01-01T10:00:00Z');
    const t1 = new Date('2026-01-01T10:05:00Z');

    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-null',
      direction: 'inbound',
      textBody: null,
      receivedAt: t0,
    });
    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-text',
      direction: 'inbound',
      textBody: 'visible',
      receivedAt: t1,
    });

    const result = await getConversationHistory(db.withTenant, TENANT_A, CONTACT_A1);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('visible');
  });

  it('is RLS-scoped: tenant B cannot read tenant A messages', async () => {
    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-tenant-a',
      direction: 'inbound',
      textBody: 'secret',
      receivedAt: new Date('2026-01-01T10:00:00Z'),
    });

    // Querying as TENANT_B — should return nothing (RLS scopes to tenant B)
    const result = await getConversationHistory(db.withTenant, TENANT_B, CONTACT_A1);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isWithin24hServiceWindow
// ---------------------------------------------------------------------------

describe('isWithin24hServiceWindow', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.truncate();
    await seedContact(db, { tenantId: TENANT_A, contactId: CONTACT_A1, phoneE164: '+51999000001' });
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('returns false when no inbound messages exist for the contact', async () => {
    const result = await isWithin24hServiceWindow(db.withTenant, TENANT_A, CONTACT_A1);
    expect(result).toBe(false);
  });

  it('returns true when the last inbound message is within 24 hours', async () => {
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour ago
    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-recent',
      direction: 'inbound',
      textBody: 'hi',
      receivedAt: recentTime,
    });

    const result = await isWithin24hServiceWindow(db.withTenant, TENANT_A, CONTACT_A1);
    expect(result).toBe(true);
  });

  it('returns false when the last inbound message is more than 24 hours ago', async () => {
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-old',
      direction: 'inbound',
      textBody: 'old message',
      receivedAt: oldTime,
    });

    const result = await isWithin24hServiceWindow(db.withTenant, TENANT_A, CONTACT_A1);
    expect(result).toBe(false);
  });

  it('ignores outbound messages when calculating the window', async () => {
    // Only an outbound message that is recent — should not count for the 24h window
    const recentTime = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    await seedMessage(db, {
      tenantId: TENANT_A,
      contactId: CONTACT_A1,
      wamid: 'wamid-out-recent',
      direction: 'outbound',
      textBody: 'outbound reply',
      receivedAt: recentTime,
    });

    const result = await isWithin24hServiceWindow(db.withTenant, TENANT_A, CONTACT_A1);
    expect(result).toBe(false);
  });
});
