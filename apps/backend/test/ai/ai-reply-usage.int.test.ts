/**
 * ai-reply-usage.int.test.ts — ai_reply_usage persistence against a real Postgres
 * (Testcontainers, migrations 0000–0004 + 0009). LLM and Meta egress are fakes.
 *
 * Scenarios:
 * (a) tool loop with 2 LLM calls → ONE 'sent' row with summed tokens, linked by
 *     outbound_wamid to the outbound message row written in the same transaction.
 * (b) atomicity: when the usage insert fails, the outbound message row rolls back too.
 * (c) send fails after the LLM ran → ONE 'send_failed' row without outbound wamid.
 * (d) manual send (no AI payload) → message row only, no usage row.
 * (e) RLS: another tenant cannot read the rows; WITH CHECK rejects cross-tenant inserts.
 */

import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiReplyUsageRecord } from '../../src/ai/ai-reply-usage.repository.js';
import {
  insertAiReplyUsageTx,
  persistAiReplyUsage,
} from '../../src/ai/ai-reply-usage.repository.js';
import { runAiReply } from '../../src/ai/ai-reply.service.js';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import { aiReplyUsageTable } from '../../src/db/schema/ai-reply-usage.schema.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { ok } from '../../src/shared/result.js';
import { sendWhatsappText } from '../../src/whatsapp-send/whatsapp-send.service.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';
import {
  adminOutboundRows,
  adminUsageRows,
  applyAiReplyUsageMigration,
} from './ai-reply-usage-db.helper.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONTACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PHONE = '+51987654321';
const PHONE_NUMBER_ID = 'pnid-usage-1';

const TOOL_TURN = ok({
  text: null,
  toolUses: [{ id: 'fc-1', name: 'getBusinessInfo', input: {} }],
  stopReason: 'tool_use' as const,
  usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 120 },
  answeredBy: { provider: 'gemini' as const, model: 'gemini-3.5-flash-lite' },
  fallbackAttempts: [],
});
const TEXT_TURN = ok({
  text: 'Abrimos de 9 a 18.',
  toolUses: [],
  stopReason: 'end_turn' as const,
  usage: { inputTokens: 150, outputTokens: 30, cachedInputTokens: 64, totalTokens: 180 },
  answeredBy: { provider: 'openai' as const, model: 'gpt-6-luna' },
  fallbackAttempts: [
    { model: 'gemini:gemini-3.5-flash-lite', reason: 'http_error' as const, status: 503 },
  ],
});

const RECORD: AiReplyUsageRecord = {
  contactId: CONTACT_ID,
  inboundWamid: 'wamid-in-1',
  outboundWamid: null,
  status: 'send_failed',
  provider: 'gemini',
  model: 'gemini-3.5-flash',
  inputTokens: 10,
  outputTokens: 2,
  reasoningTokens: null,
  cachedInputTokens: null,
  totalTokens: 12,
  llmCalls: 1,
  toolCalls: [],
  fallbackAttempts: [],
  latencyMs: 5,
};

function makeDeps(db: TestDb) {
  const meta = createFakeMetaClient();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    meta,
    logger,
    deps: {
      db,
      meta,
      llm: createFakeLlmAdapter(),
      logger: logger as unknown as Parameters<typeof runAiReply>[0]['logger'],
      env: { ENABLE_DEV_ENDPOINTS: false } as unknown as Parameters<typeof runAiReply>[0]['env'],
    },
  };
}

async function seedConversation(db: TestDb): Promise<void> {
  await db.adminQuery(async (tx) => {
    await tx.execute(rawSql`
      INSERT INTO contacts (id, tenant_id, phone_e164)
      VALUES (${CONTACT_ID}::uuid, ${TENANT_A}::uuid, ${PHONE})
    `);
    await tx.execute(rawSql`
      INSERT INTO tenant_ai_config (tenant_id, vertical, business_name, business_info, enabled)
      VALUES (${TENANT_A}::uuid, 'tienda_general', 'Test Store', '{}'::jsonb, true)
    `);
    await tx.execute(rawSql`
      INSERT INTO whatsapp_messages
        (tenant_id, wamid, phone_number_id, contact_id, from_phone_e164,
         message_type, text_body, raw_payload, received_at, direction)
      VALUES
        (${TENANT_A}::uuid, 'wamid-in-1', ${PHONE_NUMBER_ID}, ${CONTACT_ID}::uuid, ${PHONE},
         'text', 'Hola', '{}'::jsonb, now(), 'inbound')
    `);
  });
  await db.seedWhatsappAccount({
    phoneNumberId: PHONE_NUMBER_ID,
    tenantId: TENANT_A,
    displayPhoneNumber: '+51111111111',
    wabaId: 'waba-usage',
    accessToken: 'test-access-token',
  });
}

describe('ai_reply_usage — persistence (Testcontainers)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await applyAiReplyUsageMigration(testDb);
  });

  beforeEach(async () => {
    await testDb.truncate();
    await seedConversation(testDb);
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  it('(a) tool loop with 2 LLM calls → one sent row linked to the outbound message', async () => {
    const { deps } = makeDeps(testDb);
    deps.llm = createFakeLlmAdapter([TOOL_TURN, TEXT_TURN]);

    const result = await runAiReply(deps, {
      tenantId: TENANT_A,
      contactId: CONTACT_ID,
      fromPhoneE164: PHONE,
      text: 'Hola',
      inboundWamid: 'wamid-in-1',
    });

    expect(result.ok).toBe(true);
    const outbound = await adminOutboundRows(testDb, TENANT_A);
    expect(outbound.map((r) => r.wamid)).toEqual(['wamid-fake-1']);

    const rows = await adminUsageRows(testDb, TENANT_A);
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? {};
    expect(row).toMatchObject({
      tenant_id: TENANT_A,
      contact_id: CONTACT_ID,
      inbound_wamid: 'wamid-in-1',
      outbound_wamid: 'wamid-fake-1',
      status: 'sent',
      provider: 'openai',
      model: 'gpt-6-luna',
      input_tokens: 250,
      output_tokens: 50,
      reasoning_tokens: 5,
      cached_input_tokens: 64,
      total_tokens: 300,
      llm_calls: 2,
      tool_calls: ['getBusinessInfo'],
      fallback_attempts: [
        { call: 2, model: 'gemini:gemini-3.5-flash-lite', reason: 'http_error', status: 503 },
      ],
      deleted_at: null,
    });
    expect(row.latency_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('(b) atomic: a failing usage insert rolls back the outbound message row as well', async () => {
    const { deps, meta } = makeDeps(testDb);

    const result = await sendWhatsappText(
      deps,
      TENANT_A,
      { to: PHONE, text: 'hola' },
      {
        // status violates the CHECK constraint → the usage INSERT fails inside the tx.
        persistInTx: async (tx, { wamid }) => {
          await insertAiReplyUsageTx(tx, TENANT_A, {
            ...RECORD,
            outboundWamid: wamid,
            status: 'bogus' as unknown as AiReplyUsageRecord['status'],
          });
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_ERROR');
    expect(meta.calls).toHaveLength(1); // the reply itself was delivered before the tx
    expect(await adminOutboundRows(testDb, TENANT_A)).toHaveLength(0);
    expect(await adminUsageRows(testDb, TENANT_A)).toHaveLength(0);
  });

  it('(c) send fails after the LLM ran → one send_failed row without outbound wamid', async () => {
    const { deps, meta } = makeDeps(testDb);
    deps.llm = createFakeLlmAdapter([TEXT_TURN]);
    meta.queueError({ code: 'META_API_ERROR', metaCode: 190 });

    const result = await runAiReply(deps, {
      tenantId: TENANT_A,
      contactId: CONTACT_ID,
      fromPhoneE164: PHONE,
      text: 'Hola',
      inboundWamid: 'wamid-in-1',
    });

    expect(result.ok).toBe(false);
    expect(await adminOutboundRows(testDb, TENANT_A)).toHaveLength(0);
    const rows = await adminUsageRows(testDb, TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'send_failed',
      outbound_wamid: null,
      inbound_wamid: 'wamid-in-1',
      provider: 'openai',
      model: 'gpt-6-luna',
      input_tokens: 150,
      output_tokens: 30,
      total_tokens: 180,
      llm_calls: 1,
      tool_calls: [],
    });
  });

  it('(d) manual send without an AI payload → message row only, no usage row', async () => {
    const { deps } = makeDeps(testDb);

    const result = await sendWhatsappText(deps, TENANT_A, { to: PHONE, text: 'Hola operador' });

    expect(result.ok).toBe(true);
    expect(await adminOutboundRows(testDb, TENANT_A)).toHaveLength(1);
    expect(await adminUsageRows(testDb, TENANT_A)).toHaveLength(0);
  });

  it('(e) RLS: tenant B cannot read tenant A rows; WITH CHECK rejects cross-tenant inserts', async () => {
    await expect(persistAiReplyUsage(testDb.withTenant, TENANT_A, RECORD)).resolves.toBe(
      'inserted',
    );

    const seenByA = await testDb.withTenant(TENANT_A, (tx) => tx.select().from(aiReplyUsageTable));
    const seenByB = await testDb.withTenant(TENANT_B, (tx) => tx.select().from(aiReplyUsageTable));
    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(0);

    await expect(
      testDb.withTenant(TENANT_B, (tx) => insertAiReplyUsageTx(tx, TENANT_A, RECORD)),
    ).rejects.toThrow();
    expect(await adminUsageRows(testDb, TENANT_A)).toHaveLength(1);
  });
});
