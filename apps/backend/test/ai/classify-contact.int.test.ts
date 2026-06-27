/**
 * classify-contact.int.test.ts — Integration tests for the classifyContact tool.
 *
 * Uses Testcontainers (postgres:16-alpine + all 5 migrations).
 * All assertions run through the app_rls-scoped TenantRunner (RLS enforced).
 *
 * Scenarios:
 * - classifyContact writes intent + tags + intentConfidence to the contact row.
 * - Tenant B's contact is invisible when executeTool runs for Tenant A (RLS isolation).
 * - Contact not found → err(CONTACT_NOT_FOUND) in tool message content.
 */

import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../../src/ai/tool-registry.js';
import { contactsTable } from '../../src/db/schema/contacts.schema.js';
import type { TenantAiConfig } from '../../src/db/schema/tenant-ai-config.schema.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONTACT_A1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONTACT_B1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(tenantId: string): TenantAiConfig {
  return {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    tenantId,
    vertical: 'tienda_general',
    businessName: 'Test Store',
    businessInfo: {},
    enabled: true,
    systemPromptOverride: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };
}

/** Fake logger — suppresses output in CI. */
const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedContact(
  db: TestDb,
  contactId: string,
  tenantId: string,
  phone: string,
): Promise<void> {
  await db.adminQuery(async (tx) => {
    await tx.execute(rawSql`
      INSERT INTO contacts (id, tenant_id, phone_e164)
      VALUES (${contactId}::uuid, ${tenantId}::uuid, ${phone})
      ON CONFLICT DO NOTHING
    `);
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('classifyContact (via executeTool)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.truncate();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('writes intent, tags, and intentConfidence to the contact row', async () => {
    await seedContact(db, CONTACT_A1, TENANT_A, '+51999000001');

    const block = {
      id: 'tool-int-001',
      name: 'classifyContact',
      input: {
        contactId: CONTACT_A1,
        intent: 'hacer_pedido',
        tags: ['cliente', 'interesado'],
        intentConfidence: 0.85,
      },
    };

    const msg = await executeTool(
      {
        db: { withTenant: db.withTenant },
        logger: fakeLogger as Parameters<typeof executeTool>[0]['logger'],
      },
      TENANT_A,
      block,
      makeConfig(TENANT_A),
    );

    expect(msg.role).toBe('tool');
    const content = JSON.parse(msg.content);
    expect(content.classified).toBe(true);

    // Verify the DB row was updated correctly (adminQuery bypasses RLS)
    await db.adminQuery(async (tx) => {
      const rows = await tx
        .select({
          intent: contactsTable.intent,
          tags: contactsTable.tags,
          intentConfidence: contactsTable.intentConfidence,
        })
        .from(contactsTable)
        .where(rawSql`${contactsTable.id} = ${CONTACT_A1}::uuid`);

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.intent).toBe('hacer_pedido');
      expect(row?.tags).toEqual(['cliente', 'interesado']);
      // intentConfidence is stored as NUMERIC(5,4) → string from postgres driver
      expect(Number(row?.intentConfidence)).toBeCloseTo(0.85, 3);
    });
  });

  it('is RLS-isolated: tenant A executeTool cannot classify tenant B contact', async () => {
    await seedContact(db, CONTACT_B1, TENANT_B, '+51999000002');

    const block = {
      id: 'tool-int-002',
      name: 'classifyContact',
      input: {
        contactId: CONTACT_B1, // Tenant B's contact
        intent: 'ver_catalogo',
        tags: [],
      },
    };

    // Run executeTool as TENANT_A — should not find TENANT_B's contact (RLS)
    const msg = await executeTool(
      {
        db: { withTenant: db.withTenant },
        logger: fakeLogger as Parameters<typeof executeTool>[0]['logger'],
      },
      TENANT_A, // ← Tenant A, not B
      block,
      makeConfig(TENANT_A),
    );

    expect(msg.role).toBe('tool');
    const content = JSON.parse(msg.content);
    // RLS prevents tenant A from seeing tenant B's contact → CONTACT_NOT_FOUND
    expect(content.error).toBe('CONTACT_NOT_FOUND');
  });

  it('contact not found → CONTACT_NOT_FOUND error in tool message content', async () => {
    const nonExistentId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    const block = {
      id: 'tool-int-003',
      name: 'classifyContact',
      input: {
        contactId: nonExistentId,
        intent: 'otro',
        tags: [],
      },
    };

    const msg = await executeTool(
      {
        db: { withTenant: db.withTenant },
        logger: fakeLogger as Parameters<typeof executeTool>[0]['logger'],
      },
      TENANT_A,
      block,
      makeConfig(TENANT_A),
    );

    expect(msg.role).toBe('tool');
    const content = JSON.parse(msg.content);
    expect(content.error).toBe('CONTACT_NOT_FOUND');
  });
});
