/**
 * ai-reply.int.test.ts — End-to-end integration test for runAiReply orchestrator.
 *
 * Strict TDD: test written RED before verifying GREEN.
 *
 * Uses Testcontainers (postgres:16-alpine + all 5 migrations). Seeds real DB rows so
 * the full runAiReply → getTenantAiConfig → isWithin24hServiceWindow →
 * getConversationHistory → llm.complete → sendWhatsappText stack executes against
 * a real Postgres. LLM and Meta egress are replaced with fakes.
 *
 * Scenarios:
 * (a) Happy path: AI enabled, 24h window open, fake LLM returns text → sendWhatsappText called
 *     with correct phone, pino 'ai_reply_sent' logged, ok({wamid, toolCalls}) returned.
 * (b) AI disabled (no tenant_ai_config row) → runAiReply returns err(AI_DISABLED), no send.
 * (c) 24h window closed (last inbound > 24h ago) → err(WINDOW_CLOSED), no send.
 */

import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAiReply } from '../../src/ai/ai-reply.service.js';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { ok } from '../../src/shared/result.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONTACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const FROM_PHONE_E164 = '+51987654321';
const PHONE_NUMBER_ID = '111';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake pino-compatible logger — records calls for assertions. */
function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Seed a contact row directly via adminQuery (bypasses RLS). */
async function seedContact(db: TestDb): Promise<void> {
  await db.adminQuery(async (tx) => {
    await tx.execute(rawSql`
      INSERT INTO contacts (id, tenant_id, phone_e164)
      VALUES (${CONTACT_ID}::uuid, ${TENANT_ID}::uuid, ${FROM_PHONE_E164})
      ON CONFLICT DO NOTHING
    `);
  });
}

/**
 * Seed a whatsapp_accounts row with a valid access_token.
 * sendWhatsappText needs this to resolve the active account.
 */
async function seedWhatsappAccount(db: TestDb): Promise<void> {
  await db.seedWhatsappAccount({
    phoneNumberId: PHONE_NUMBER_ID,
    tenantId: TENANT_ID,
    displayPhoneNumber: FROM_PHONE_E164,
    wabaId: 'waba-test',
    accessToken: 'test-access-token',
  });
}

/**
 * Seed a tenant_ai_config row with enabled=true.
 * Needed so getTenantAiConfig returns a config instead of null.
 */
async function seedTenantAiConfig(db: TestDb): Promise<void> {
  await db.adminQuery(async (tx) => {
    await tx.execute(rawSql`
      INSERT INTO tenant_ai_config
        (id, tenant_id, vertical, business_name, business_info, enabled)
      VALUES
        (gen_random_uuid(), ${TENANT_ID}::uuid, 'tienda_general', 'Test Store', '{}'::jsonb, true)
      ON CONFLICT DO NOTHING
    `);
  });
}

/**
 * Seed an inbound message with a controllable received_at.
 * Needed for the 24h service window check.
 */
async function seedInboundMessage(
  db: TestDb,
  receivedAt: string, // ISO-8601 or SQL relative (e.g. 'now()')
): Promise<void> {
  await db.adminQuery(async (tx) => {
    await tx.execute(rawSql`
      INSERT INTO whatsapp_messages
        (id, tenant_id, wamid, phone_number_id, contact_id, from_phone_e164,
         message_type, text_body, raw_payload, received_at, direction)
      VALUES
        (gen_random_uuid(),
         ${TENANT_ID}::uuid,
         gen_random_uuid()::text,
         ${PHONE_NUMBER_ID},
         ${CONTACT_ID}::uuid,
         ${FROM_PHONE_E164},
         'text',
         'Hola',
         '{}'::jsonb,
         ${receivedAt}::timestamptz,
         'inbound')
    `);
  });
}

/** Base AppDeps partial used for runAiReply (db provided per-test). */
function makeRunDeps(db: TestDb) {
  const fakeMeta = createFakeMetaClient();
  const fakeLlm = createFakeLlmAdapter();
  const fakeLogger = makeFakeLogger();

  return {
    deps: {
      db,
      meta: fakeMeta,
      llm: fakeLlm,
      logger: fakeLogger as unknown as Parameters<typeof runAiReply>[0]['logger'],
      env: { ENABLE_DEV_ENDPOINTS: false } as unknown as Parameters<typeof runAiReply>[0]['env'],
    },
    fakeMeta,
    fakeLlm,
    fakeLogger,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runAiReply — E2E integration (Testcontainers)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await testDb.truncate();
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  // -------------------------------------------------------------------------
  // (a) Happy path
  // -------------------------------------------------------------------------

  it('(a) AI enabled + window open + fake LLM text → sendWhatsappText called, ai_reply_sent logged', async () => {
    // Arrange
    await seedContact(testDb);
    await seedWhatsappAccount(testDb);
    await seedTenantAiConfig(testDb);
    // Seed an inbound message received just now (window open)
    await seedInboundMessage(testDb, new Date().toISOString());

    const { deps, fakeMeta, fakeLlm, fakeLogger } = makeRunDeps(testDb);

    // Script the fake LLM to return a text response immediately (no tool calls)
    fakeLlm.queueResponse(
      ok({ text: 'Hola, ¿en qué te puedo ayudar?', toolUses: [], stopReason: 'end_turn' }),
    );

    // Act
    const result = await runAiReply(deps, {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      fromPhoneE164: FROM_PHONE_E164,
      text: 'Hola',
    });

    // Assert: result is ok
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wamid).toBe('wamid-fake-1');
      expect(result.value.toolCalls).toEqual([]);
    }

    // Assert: sendWhatsappText was called with the correct phone
    expect(fakeMeta.calls).toHaveLength(1);
    expect(fakeMeta.calls[0]?.to).toBe(FROM_PHONE_E164);

    // Assert: LLM was invoked once
    expect(fakeLlm.calls).toHaveLength(1);

    // Assert: pino logged 'ai_reply_sent'
    expect(fakeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ wamid: 'wamid-fake-1', toolCalls: [] }),
      'ai_reply_sent',
    );
  });

  // -------------------------------------------------------------------------
  // (b) AI disabled (no config row)
  // -------------------------------------------------------------------------

  it('(b) no tenant_ai_config row → err(AI_DISABLED), no send, no LLM call', async () => {
    // Arrange — intentionally skip seedTenantAiConfig
    await seedContact(testDb);
    await seedWhatsappAccount(testDb);
    await seedInboundMessage(testDb, new Date().toISOString());

    const { deps, fakeMeta, fakeLlm } = makeRunDeps(testDb);

    // Act
    const result = await runAiReply(deps, {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      fromPhoneE164: FROM_PHONE_E164,
      text: 'Hola',
    });

    // Assert: returned AI_DISABLED
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AI_DISABLED');
    }

    // Assert: no Meta egress, no LLM call
    expect(fakeMeta.calls).toHaveLength(0);
    expect(fakeLlm.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // (c) 24h window closed
  // -------------------------------------------------------------------------

  it('(c) last inbound message > 24h ago → err(WINDOW_CLOSED), no send', async () => {
    // Arrange — inbound message is 25 hours old (window closed)
    await seedContact(testDb);
    await seedWhatsappAccount(testDb);
    await seedTenantAiConfig(testDb);
    // Use DB time subtraction to ensure server-side correctness
    await testDb.adminQuery(async (tx) => {
      await tx.execute(rawSql`
        INSERT INTO whatsapp_messages
          (id, tenant_id, wamid, phone_number_id, contact_id, from_phone_e164,
           message_type, text_body, raw_payload, received_at, direction)
        VALUES
          (gen_random_uuid(),
           ${TENANT_ID}::uuid,
           'old-wamid',
           ${PHONE_NUMBER_ID},
           ${CONTACT_ID}::uuid,
           ${FROM_PHONE_E164},
           'text',
           'Mensaje antiguo',
           '{}'::jsonb,
           NOW() - INTERVAL '25 hours',
           'inbound')
      `);
    });

    const { deps, fakeMeta } = makeRunDeps(testDb);

    // Act
    const result = await runAiReply(deps, {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      fromPhoneE164: FROM_PHONE_E164,
      text: 'Hola de nuevo',
    });

    // Assert: returned WINDOW_CLOSED
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WINDOW_CLOSED');
    }

    // Assert: no Meta egress
    expect(fakeMeta.calls).toHaveLength(0);
  });
});
