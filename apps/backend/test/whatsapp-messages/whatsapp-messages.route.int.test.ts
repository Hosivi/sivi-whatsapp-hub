/**
 * whatsapp-messages.route.int.test.ts — Integration tests for GET /whatsapp-messages.
 *
 * Uses Testcontainers (PG16) + buildApp({ db, env }).
 *
 * Tests:
 * (a) GET /whatsapp-messages without X-Tenant-Id → 401
 * (b) tenant with no messages → 200 []
 * (c) two messages with T1 < T2 → list has T2 first (received_at DESC)
 * (d) RLS isolation: tenant B messages not visible under tenant A context
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { contactsTable } from '../../src/db/schema/contacts.schema.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';
import { applyAiReplyUsageMigration } from '../ai/ai-reply-usage-db.helper.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PHONE_NUMBER_ID_A = 'pnid-111';
const PHONE_NUMBER_ID_B = 'pnid-222';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_ADMIN_URL: 'postgresql://unused:unused@localhost:5432/unused',
    AUTH_MODE: 'dev-header',
    PORT: 3001,
    LOG_LEVEL: 'silent',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    WHATSAPP_APP_SECRET: 'test-app-secret',
    DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost:5432/unused',
    ENABLE_DEV_ENDPOINTS: false,
    WHATSAPP_META_API_VERSION: 'v21.0',
    ...overrides,
  };
}

/**
 * Inserts a whatsapp_messages row directly via admin (bypasses RLS).
 * Requires the contact to already exist (FK constraint).
 */
async function seedMessage(
  db: TestDb,
  opts: {
    tenantId: string;
    wamid: string;
    phoneNumberId: string;
    contactId: string;
    fromPhone: string;
    textBody: string;
    receivedAt: Date;
    direction?: 'inbound' | 'outbound';
  },
): Promise<void> {
  await db.adminQuery((tx) =>
    tx.execute(
      rawSql`
        INSERT INTO whatsapp_messages
          (tenant_id, wamid, phone_number_id, contact_id, from_phone_e164,
           message_type, text_body, raw_payload, received_at, direction)
        VALUES
          (${opts.tenantId}::uuid,
           ${opts.wamid},
           ${opts.phoneNumberId},
           ${opts.contactId}::uuid,
           ${opts.fromPhone},
           'text',
           ${opts.textBody},
           ${'{}'}::jsonb,
           ${opts.receivedAt.toISOString()}::timestamptz,
           ${opts.direction ?? 'inbound'})
      `,
    ),
  );
}

/** Inserts an ai_reply_usage row directly via admin (bypasses RLS). */
async function seedUsage(
  db: TestDb,
  opts: { tenantId: string; outboundWamid: string; deleted?: boolean },
): Promise<void> {
  await db.adminQuery((tx) =>
    tx.execute(
      rawSql`
        INSERT INTO ai_reply_usage
          (tenant_id, outbound_wamid, status, provider, model, input_tokens, output_tokens,
           reasoning_tokens, total_tokens, llm_calls, tool_calls, fallback_attempts,
           latency_ms, deleted_at)
        VALUES
          (${opts.tenantId}::uuid, ${opts.outboundWamid}, 'sent', 'openai', 'gpt-6-luna',
           250, 50, 5, 300, 2, ARRAY['getBusinessInfo']::text[],
           ${JSON.stringify([{ call: 2, model: 'gemini:x', reason: 'http_error', status: 503 }])}::jsonb,
           1234, ${opts.deleted ? new Date().toISOString() : null}::timestamptz)
      `,
    ),
  );
}

/**
 * Gets the ID of a contact seeded for a given tenant+phone (via admin query).
 */
async function getContactId(db: TestDb, tenantId: string, phoneE164: string): Promise<string> {
  const rows = await db.adminQuery((tx) =>
    tx
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(rawSql`tenant_id = ${tenantId}::uuid AND phone_e164 = ${phoneE164}`),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`Contact not found: ${tenantId} / ${phoneE164}`);
  return id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /whatsapp-messages', () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    await applyAiReplyUsageMigration(db);
    app = buildApp({ db, env: makeEnv(), meta: createFakeMetaClient() });
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  // -------------------------------------------------------------------------
  // (a) missing X-Tenant-Id → 401
  // -------------------------------------------------------------------------

  it('(a) missing X-Tenant-Id → 401', async () => {
    const res = await app.request('/whatsapp-messages');
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // (b) empty list when no messages
  // -------------------------------------------------------------------------

  it('(b) tenant with no messages → 200 with empty data array', async () => {
    const res = await app.request('/whatsapp-messages', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (c) ordering: received_at DESC
  // -------------------------------------------------------------------------

  it('(c) two messages T1 < T2 → T2 appears first in response', async () => {
    // Seed a contact for tenant A
    await db.seedTenant(TENANT_A, { phoneE164: '+51987654321', fullName: 'Alice' });
    const contactId = await getContactId(db, TENANT_A, '+51987654321');

    const t1 = new Date('2024-01-01T10:00:00Z');
    const t2 = new Date('2024-01-01T11:00:00Z');

    await seedMessage(db, {
      tenantId: TENANT_A,
      wamid: 'wamid-t1',
      phoneNumberId: PHONE_NUMBER_ID_A,
      contactId,
      fromPhone: '+51987654321',
      textBody: 'First message',
      receivedAt: t1,
    });
    await seedMessage(db, {
      tenantId: TENANT_A,
      wamid: 'wamid-t2',
      phoneNumberId: PHONE_NUMBER_ID_A,
      contactId,
      fromPhone: '+51987654321',
      textBody: 'Second message',
      receivedAt: t2,
    });

    const res = await app.request('/whatsapp-messages', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ wamid: string }> };
    expect(body.data.length).toBe(2);
    // T2 first (DESC order)
    expect(body.data[0]?.wamid).toBe('wamid-t2');
    expect(body.data[1]?.wamid).toBe('wamid-t1');
  });

  // -------------------------------------------------------------------------
  // (d) RLS isolation: tenant B messages not visible under tenant A
  // -------------------------------------------------------------------------

  it('(d) RLS isolation: tenant A cannot see tenant B messages', async () => {
    // Seed contacts and whatsapp_accounts for both tenants
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID_B,
      tenantId: TENANT_B,
      displayPhoneNumber: '+51222222222',
      wabaId: 'waba_b',
    });

    await db.seedTenant(TENANT_B, { phoneE164: '+51222222222', fullName: 'Bob' });
    const contactIdB = await getContactId(db, TENANT_B, '+51222222222');

    await seedMessage(db, {
      tenantId: TENANT_B,
      wamid: 'wamid-tenant-b',
      phoneNumberId: PHONE_NUMBER_ID_B,
      contactId: contactIdB,
      fromPhone: '+51222222222',
      textBody: 'Tenant B message',
      receivedAt: new Date(),
    });

    // Query as tenant A — must see zero rows (RLS isolation)
    const res = await app.request('/whatsapp-messages', {
      headers: { 'X-Tenant-Id': TENANT_A },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ wamid: string }> };
    const tenantBMessages = body.data.filter((m) => m.wamid === 'wamid-tenant-b');
    expect(tenantBMessages.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (e)/(f) author + AI usage (ai-usage-visibility T2)
  // -------------------------------------------------------------------------

  type AuthoredMessage = {
    wamid: string;
    name: string | null;
    phone: string;
    direction: string;
    author: string;
    ai: Record<string, unknown> | null;
  };

  async function seedAliceConversation(): Promise<void> {
    await db.seedTenant(TENANT_A, { phoneE164: '+51987654321', fullName: 'Alice' });
    const contactId = await getContactId(db, TENANT_A, '+51987654321');
    const base = {
      tenantId: TENANT_A,
      phoneNumberId: PHONE_NUMBER_ID_A,
      contactId,
      fromPhone: '+51987654321',
    };
    await seedMessage(db, {
      ...base,
      wamid: 'wamid-in',
      textBody: 'Hola',
      receivedAt: new Date('2024-01-01T10:00:00Z'),
    });
    for (const [index, wamid] of ['wamid-ai', 'wamid-op', 'wamid-ai-deleted'].entries()) {
      await seedMessage(db, {
        ...base,
        wamid,
        textBody: `outbound ${wamid}`,
        receivedAt: new Date(Date.UTC(2024, 0, 1, 11 + index)),
        direction: 'outbound',
      });
    }
  }

  async function listAsTenantA(): Promise<Map<string, AuthoredMessage>> {
    const res = await app.request('/whatsapp-messages', { headers: { 'X-Tenant-Id': TENANT_A } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: AuthoredMessage[] };
    return new Map(body.data.map((m) => [m.wamid, m]));
  }

  it('(e) author: inbound → customer; outbound with a live usage row → ai (+usage); else operator', async () => {
    await seedAliceConversation();
    await seedUsage(db, { tenantId: TENANT_A, outboundWamid: 'wamid-ai' });
    await seedUsage(db, { tenantId: TENANT_A, outboundWamid: 'wamid-ai-deleted', deleted: true });

    const messages = await listAsTenantA();

    expect(messages.get('wamid-in')).toMatchObject({
      author: 'customer',
      ai: null,
      name: 'Alice',
      phone: '+51987654321',
      direction: 'inbound',
    });
    expect(messages.get('wamid-ai')).toMatchObject({
      author: 'ai',
      name: 'Alice',
      phone: '+51987654321',
      direction: 'outbound',
      ai: {
        provider: 'openai',
        model: 'gpt-6-luna',
        inputTokens: 250,
        outputTokens: 50,
        reasoningTokens: 5,
        totalTokens: 300,
        latencyMs: 1234,
        llmCalls: 2,
        toolCalls: ['getBusinessInfo'],
        fallbackCount: 1,
      },
    });
    expect(messages.get('wamid-op')).toMatchObject({ author: 'operator', ai: null });
    // Soft-deleted usage rows do not make a message AI-authored.
    expect(messages.get('wamid-ai-deleted')).toMatchObject({ author: 'operator', ai: null });
  });

  it("(f) RLS: another tenant's usage row never marks this tenant's message as AI", async () => {
    await seedAliceConversation();
    await seedUsage(db, { tenantId: TENANT_B, outboundWamid: 'wamid-op' });

    const messages = await listAsTenantA();

    expect(messages.get('wamid-op')).toMatchObject({ author: 'operator', ai: null });
  });
});
