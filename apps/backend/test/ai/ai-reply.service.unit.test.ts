/**
 * ai-reply.service.unit.test.ts — Unit tests for runAiReply orchestrator.
 *
 * Strict TDD: written RED before implementation.
 * NO DB — uses:
 * - createFakeLlmAdapter(script) for LLM
 * - createFakeMetaClient() for Meta egress (through sendWhatsappText)
 * - vi.mock() for all external module imports
 * - Fake withTenant returning { within_window: true/false } for isWithin24hServiceWindow
 *
 * Scenarios:
 * (a) AI disabled (config ok(null)) → err(AI_DISABLED), pino info
 * (b) Window closed → err(WINDOW_CLOSED), pino info
 * (c) LLM text first call → sendWhatsappText called once, returns ok
 * (d) One tool call then text → executeTool once, sendWhatsappText once
 * (e) Always-tool-call (max 5) → warn log, NO sendWhatsappText, returns err(LLM_FAILED)
 * (f) Tool returns error → error content fed back, LLM responds with text, reply sent
 * (g) LLM error → err(LLM_FAILED), no reply
 * (h) Send error → err(SEND_FAILED), pino error
 * (i) Unexpected exception inside → caught, pino error, no unhandled rejection
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import type { LlmMessage } from '../../src/ai/llm-types.js';
import type { TenantRunner } from '../../src/db/client.js';
import type { TenantAiConfig } from '../../src/db/schema/tenant-ai-config.schema.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { err, ok } from '../../src/shared/result.js';

// ---------------------------------------------------------------------------
// Module mocks — all external modules that runAiReply calls
// ---------------------------------------------------------------------------

const mockGetTenantAiConfig = vi.fn();
const mockGetConversationHistory = vi.fn();
const mockSendWhatsappText = vi.fn();
const mockExecuteTool = vi.fn();
const mockInsertAiReplyUsageTx = vi.fn();
const mockPersistAiReplyUsage = vi.fn();

vi.mock('../../src/ai/ai-reply-usage.repository.js', () => ({
  insertAiReplyUsageTx: (...args: unknown[]) => mockInsertAiReplyUsageTx(...args),
  persistAiReplyUsage: (...args: unknown[]) => mockPersistAiReplyUsage(...args),
}));

vi.mock('../../src/ai/tenant-ai-config.repository.js', () => ({
  getTenantAiConfig: (...args: unknown[]) => mockGetTenantAiConfig(...args),
}));

vi.mock('../../src/whatsapp-messages/whatsapp-messages.repository.js', () => ({
  getConversationHistory: (...args: unknown[]) => mockGetConversationHistory(...args),
  listMessages: vi.fn(),
}));

vi.mock('../../src/whatsapp-send/whatsapp-send.service.js', () => ({
  sendWhatsappText: (...args: unknown[]) => mockSendWhatsappText(...args),
  resolveActiveAccount: vi.fn(),
}));

vi.mock('../../src/ai/tool-registry.js', () => ({
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
  REGISTRY: [
    { name: 'getBusinessInfo', description: 'Get business info', inputSchema: {}, schema: {} },
  ],
  toLlmTool: (t: { name: string; description: string; schema: Record<string, unknown> }) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema ?? {},
  }),
}));

// Import AFTER mocks are set up
const { runAiReply } = await import('../../src/ai/ai-reply.service.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONTACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const FROM_PHONE = '+51999000001';

function makeConfig(overrides: Partial<TenantAiConfig> = {}): TenantAiConfig {
  return {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    tenantId: TENANT_ID,
    vertical: 'tienda_general',
    businessName: 'Test Store',
    businessInfo: {},
    enabled: true,
    systemPromptOverride: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

const INPUT = {
  tenantId: TENANT_ID,
  contactId: CONTACT_ID,
  fromPhoneE164: FROM_PHONE,
  text: 'Hola, quiero hacer un pedido',
};

/** Fake logger. */
const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/**
 * Makes a fake withTenant that controls what isWithin24hServiceWindow returns.
 * isWithin24hServiceWindow does a single SQL query and reads `within_window` from the result.
 */
function makeWindowStub(withinWindow: boolean): TenantRunner {
  return async (_tenantId, run) => {
    const fakeTx = {
      execute: vi.fn().mockResolvedValue([{ within_window: withinWindow }]),
    } as unknown as PostgresJsDatabase;
    return run(fakeTx);
  };
}

function makeAppDeps(withinWindow = true) {
  const fakeMeta = createFakeMetaClient();
  const fakeLlm = createFakeLlmAdapter();

  return {
    db: { withTenant: makeWindowStub(withinWindow) } as unknown as Parameters<
      typeof runAiReply
    >[0]['db'],
    llm: fakeLlm,
    meta: fakeMeta,
    logger: fakeLogger as unknown as Parameters<typeof runAiReply>[0]['logger'],
    env: { ENABLE_DEV_ENDPOINTS: false } as unknown as Parameters<typeof runAiReply>[0]['env'],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tool message fixture — valid tool result. */
function makeToolMsg(toolUseId: string, toolName: string, content = '{}'): LlmMessage {
  return {
    role: 'tool',
    toolUseId,
    toolName,
    content,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runAiReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: send succeeds
    mockSendWhatsappText.mockResolvedValue(ok({ wamid: 'wamid-test-1', status: 'accepted' }));
    // Default: conversation history empty
    mockGetConversationHistory.mockResolvedValue([]);
    // Default: executeTool returns a generic ok tool message
    mockExecuteTool.mockResolvedValue(makeToolMsg('fc-001', 'getBusinessInfo'));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) AI disabled — config is null
  // -------------------------------------------------------------------------

  it('(a) config ok(null) → err(AI_DISABLED), pino info, no LLM call', async () => {
    mockGetTenantAiConfig.mockResolvedValue(ok(null));
    const deps = makeAppDeps();
    const fakeLlm = createFakeLlmAdapter();
    deps.llm = fakeLlm;

    const result = await runAiReply(deps, INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AI_DISABLED');
    expect(fakeLlm.calls).toHaveLength(0);
    expect(mockSendWhatsappText).not.toHaveBeenCalled();
    expect(fakeLogger.info).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (b) Window closed
  // -------------------------------------------------------------------------

  it('(b) window closed → err(WINDOW_CLOSED), pino info, no LLM call', async () => {
    mockGetTenantAiConfig.mockResolvedValue(ok(makeConfig()));
    mockGetConversationHistory.mockResolvedValue([]);
    const deps = makeAppDeps(false); // withinWindow = false
    const fakeLlm = createFakeLlmAdapter();
    deps.llm = fakeLlm;

    const result = await runAiReply(deps, INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WINDOW_CLOSED');
    expect(fakeLlm.calls).toHaveLength(0);
    expect(mockSendWhatsappText).not.toHaveBeenCalled();
    expect(fakeLogger.info).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (c) Text reply on first call
  // -------------------------------------------------------------------------

  it('(c) LLM returns text on first call → sendWhatsappText called once, ok({ wamid })', async () => {
    mockGetTenantAiConfig.mockResolvedValue(ok(makeConfig()));

    const fakeLlm = createFakeLlmAdapter([
      ok({ text: 'Hola! ¿En qué te puedo ayudar?', toolUses: [], stopReason: 'end_turn' }),
    ]);
    const deps = makeAppDeps();
    deps.llm = fakeLlm;

    const result = await runAiReply(deps, INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wamid).toBe('wamid-test-1');
    expect(result.value.toolCalls).toEqual([]);
    expect(mockSendWhatsappText).toHaveBeenCalledOnce();
    expect(fakeLlm.calls).toHaveLength(1);
    // The message sent must be the LLM text
    const [, , sendInput] = mockSendWhatsappText.mock.calls[0];
    expect(sendInput.text).toBe('Hola! ¿En qué te puedo ayudar?');
    expect(sendInput.to).toBe(FROM_PHONE);
  });

  // -------------------------------------------------------------------------
  // (d) One tool call then text
  // -------------------------------------------------------------------------

  it('(d) one tool call then text → executeTool once, sendWhatsappText once', async () => {
    mockGetTenantAiConfig.mockResolvedValue(ok(makeConfig()));

    const fakeLlm = createFakeLlmAdapter([
      // First call: tool_use
      ok({
        text: null,
        toolUses: [{ id: 'fc-001', name: 'getBusinessInfo', input: {} }],
        stopReason: 'tool_use',
      }),
      // Second call: text reply
      ok({ text: 'La tienda abre de 9am a 6pm.', toolUses: [], stopReason: 'end_turn' }),
    ]);
    const deps = makeAppDeps();
    deps.llm = fakeLlm;
    mockExecuteTool.mockResolvedValue(
      makeToolMsg('fc-001', 'getBusinessInfo', JSON.stringify({ business_name: 'Test Store' })),
    );

    const result = await runAiReply(deps, INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.toolCalls).toEqual(['getBusinessInfo']);
    expect(mockExecuteTool).toHaveBeenCalledOnce();
    expect(mockSendWhatsappText).toHaveBeenCalledOnce();
    expect(fakeLlm.calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // (e) Always tool-call → max 5 iterations, warn log, NO reply
  // -------------------------------------------------------------------------

  it('(e) always-tool-call → 5 iterations, warn logged, sendWhatsappText NOT called, err(LLM_FAILED)', async () => {
    mockGetTenantAiConfig.mockResolvedValue(ok(makeConfig()));

    // LLM always returns a tool call (no text)
    const fakeLlm = createFakeLlmAdapter(
      Array(6).fill(
        ok({
          text: null,
          toolUses: [{ id: 'fc-x', name: 'getBusinessInfo', input: {} }],
          stopReason: 'tool_use',
        }),
      ),
    );
    const deps = makeAppDeps();
    deps.llm = fakeLlm;

    const result = await runAiReply(deps, INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('LLM_FAILED');
    expect(mockSendWhatsappText).not.toHaveBeenCalled();
    expect(fakeLogger.warn).toHaveBeenCalled();
    // Exactly 5 LLM calls
    expect(fakeLlm.calls).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // (f) Tool returns error → error content fed back, loop continues
  // -------------------------------------------------------------------------

  it('(f) tool returns error → error fed to LLM, LLM responds with text, reply sent', async () => {
    mockGetTenantAiConfig.mockResolvedValue(ok(makeConfig()));

    const fakeLlm = createFakeLlmAdapter([
      // First: tool_use
      ok({
        text: null,
        toolUses: [{ id: 'fc-e', name: 'classifyContact', input: { contactId: 'bad-id' } }],
        stopReason: 'tool_use',
      }),
      // Second: text response after receiving error from tool
      ok({ text: 'Lo siento, no pude clasificarte.', toolUses: [], stopReason: 'end_turn' }),
    ]);
    const deps = makeAppDeps();
    deps.llm = fakeLlm;
    // Tool returns an error content
    mockExecuteTool.mockResolvedValue(
      makeToolMsg('fc-e', 'classifyContact', JSON.stringify({ error: 'CONTACT_NOT_FOUND' })),
    );

    const result = await runAiReply(deps, INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.toolCalls).toEqual(['classifyContact']);
    expect(mockSendWhatsappText).toHaveBeenCalledOnce();
    expect(fakeLlm.calls).toHaveLength(2);
    // Second LLM call must include the tool error message in history
    const secondCallMessages = fakeLlm.calls[1]?.messages ?? [];
    const toolMsg = secondCallMessages.find((m: LlmMessage) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    if (toolMsg?.role === 'tool') {
      expect(JSON.parse(toolMsg.content).error).toBe('CONTACT_NOT_FOUND');
    }
  });

  // -------------------------------------------------------------------------
  // (g) LLM error → err(LLM_FAILED), no reply
  // -------------------------------------------------------------------------

  it('(g) LLM returns err → err(LLM_FAILED), no sendWhatsappText, pino error', async () => {
    mockGetTenantAiConfig.mockResolvedValue(ok(makeConfig()));

    const fakeLlm = createFakeLlmAdapter([
      err({ code: 'LLM_API_ERROR', status: 500, detail: 'Internal error' }),
    ]);
    const deps = makeAppDeps();
    deps.llm = fakeLlm;

    const result = await runAiReply(deps, INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('LLM_FAILED');
    expect(mockSendWhatsappText).not.toHaveBeenCalled();
    expect(fakeLogger.error).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (h) Send error → err(SEND_FAILED), pino error
  // -------------------------------------------------------------------------

  it('(h) sendWhatsappText fails → err(SEND_FAILED), pino error', async () => {
    mockGetTenantAiConfig.mockResolvedValue(ok(makeConfig()));

    const fakeLlm = createFakeLlmAdapter([
      ok({ text: 'Respuesta del AI', toolUses: [], stopReason: 'end_turn' }),
    ]);
    const deps = makeAppDeps();
    deps.llm = fakeLlm;
    mockSendWhatsappText.mockResolvedValue(
      err({ code: 'META_API_ERROR', metaCode: 400, detail: 'Bad request' }),
    );

    const result = await runAiReply(deps, INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SEND_FAILED');
    expect(fakeLogger.error).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (i) Unexpected exception → caught, no unhandled rejection
  // -------------------------------------------------------------------------

  it('(i) unexpected exception → caught, pino error, no unhandled rejection', async () => {
    // getTenantAiConfig throws instead of returning a Result
    mockGetTenantAiConfig.mockRejectedValue(new Error('Unexpected DB crash'));

    const deps = makeAppDeps();
    // Must not throw — must return err or handle gracefully
    let threwToHost = false;
    let result: Awaited<ReturnType<typeof runAiReply>> | undefined;
    try {
      result = await runAiReply(deps, INPUT);
    } catch {
      threwToHost = true;
    }

    // runAiReply should NEVER throw to its caller
    expect(threwToHost).toBe(false);
    // Should return an error result
    expect(result).toBeDefined();
    if (result && !result.ok) {
      // DB_ERROR or similar — just check it's an error
      expect(['DB_ERROR', 'LLM_FAILED', 'AI_DISABLED'].includes(result.error.code)).toBe(true);
    }
    expect(fakeLogger.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Usage accounting (ai-usage-visibility T1)
// ---------------------------------------------------------------------------

describe('runAiReply — usage accounting', () => {
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
  const INPUT_WITH_WAMID = { ...INPUT, inboundWamid: 'wamid-in-1' };

  /** The send options runAiReply handed to sendWhatsappText (4th argument). */
  const sendOptions = () =>
    mockSendWhatsappText.mock.calls[0]?.[3] as
      | {
          persistInTx?: (
            tx: unknown,
            persisted: { wamid: string; contactId: string },
          ) => Promise<void>;
        }
      | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantAiConfig.mockResolvedValue(ok(makeConfig()));
    mockGetConversationHistory.mockResolvedValue([]);
    mockExecuteTool.mockResolvedValue(makeToolMsg('fc-1', 'getBusinessInfo'));
    mockSendWhatsappText.mockResolvedValue(ok({ wamid: 'wamid-out-1', status: 'accepted' }));
    mockInsertAiReplyUsageTx.mockResolvedValue('inserted');
    mockPersistAiReplyUsage.mockResolvedValue(undefined);
  });

  it('(j) sums usage across a 2-call tool loop and persists ONE sent row inside the send transaction', async () => {
    const deps = makeAppDeps();
    deps.llm = createFakeLlmAdapter([TOOL_TURN, TEXT_TURN]);

    const result = await runAiReply(deps, INPUT_WITH_WAMID);
    expect(result.ok).toBe(true);

    // The usage row is written through the send persist hook (same tx as the message row).
    const options = sendOptions();
    expect(typeof options?.persistInTx).toBe('function');
    const fakeTx = { marker: 'tx' };
    await options?.persistInTx?.(fakeTx, { wamid: 'wamid-out-1', contactId: CONTACT_ID });

    expect(mockInsertAiReplyUsageTx).toHaveBeenCalledOnce();
    const [tx, tenantId, record] = mockInsertAiReplyUsageTx.mock.calls[0] ?? [];
    expect(tx).toBe(fakeTx);
    expect(tenantId).toBe(TENANT_ID);
    expect(record).toEqual({
      contactId: CONTACT_ID,
      inboundWamid: 'wamid-in-1',
      outboundWamid: 'wamid-out-1',
      status: 'sent',
      provider: 'openai',
      model: 'gpt-6-luna',
      inputTokens: 250,
      outputTokens: 50,
      reasoningTokens: 5,
      cachedInputTokens: 64,
      totalTokens: 300,
      llmCalls: 2,
      toolCalls: ['getBusinessInfo'],
      fallbackAttempts: [
        { call: 2, model: 'gemini:gemini-3.5-flash-lite', reason: 'http_error', status: 503 },
      ],
      latencyMs: expect.any(Number),
    });
    expect((record as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockPersistAiReplyUsage).not.toHaveBeenCalled();
  });

  it('(k) ai_reply_sent log carries provider, model and token totals — never prompts or customer text', async () => {
    const deps = makeAppDeps();
    deps.llm = createFakeLlmAdapter([TOOL_TURN, TEXT_TURN]);

    await runAiReply(deps, INPUT_WITH_WAMID);

    expect(fakeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        wamid: 'wamid-out-1',
        provider: 'openai',
        model: 'gpt-6-luna',
        inputTokens: 250,
        outputTokens: 50,
        reasoningTokens: 5,
        totalTokens: 300,
        llmCalls: 2,
        fallbackCount: 1,
      }),
      'ai_reply_sent',
    );
    const logged = JSON.stringify(fakeLogger.info.mock.calls);
    expect(logged).not.toContain(INPUT.text);
    expect(logged).not.toContain('Abrimos de 9 a 18.');
  });

  it('(l) send fails after the LLM ran → persists a send_failed row without outbound wamid', async () => {
    const deps = makeAppDeps();
    deps.llm = createFakeLlmAdapter([TEXT_TURN]);
    mockSendWhatsappText.mockResolvedValue(err({ code: 'META_API_ERROR' }));

    const result = await runAiReply(deps, INPUT_WITH_WAMID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SEND_FAILED');
    expect(mockPersistAiReplyUsage).toHaveBeenCalledOnce();
    const [withTenant, tenantId, record] = mockPersistAiReplyUsage.mock.calls[0] ?? [];
    expect(withTenant).toBe(deps.db.withTenant);
    expect(tenantId).toBe(TENANT_ID);
    expect(record).toEqual(
      expect.objectContaining({
        status: 'send_failed',
        outboundWamid: null,
        inboundWamid: 'wamid-in-1',
        provider: 'openai',
        model: 'gpt-6-luna',
        inputTokens: 150,
        llmCalls: 1,
      }),
    );
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-6-luna', totalTokens: 180 }),
      'ai_reply_failed reason=SEND_FAILED',
    );
  });

  it('(m) no LLM call completed → nothing is persisted', async () => {
    const deps = makeAppDeps();
    deps.llm = createFakeLlmAdapter([err({ code: 'LLM_API_ERROR', status: 500 })]);

    const result = await runAiReply(deps, INPUT_WITH_WAMID);

    expect(result.ok).toBe(false);
    expect(mockInsertAiReplyUsageTx).not.toHaveBeenCalled();
    expect(mockPersistAiReplyUsage).not.toHaveBeenCalled();
  });

  it('(n) send DB_ERROR (reply delivered, persistence failed) → no send_failed row', async () => {
    const deps = makeAppDeps();
    deps.llm = createFakeLlmAdapter([TEXT_TURN]);
    mockSendWhatsappText.mockResolvedValue(err({ code: 'DB_ERROR', cause: new Error('boom') }));

    const result = await runAiReply(deps, INPUT_WITH_WAMID);

    expect(result.ok).toBe(false);
    expect(mockPersistAiReplyUsage).not.toHaveBeenCalled();
  });

  it('(o) ai_reply_usage table missing → hook logs an error and does not throw', async () => {
    const deps = makeAppDeps();
    deps.llm = createFakeLlmAdapter([TEXT_TURN]);
    mockInsertAiReplyUsageTx.mockResolvedValue('table_missing');

    await runAiReply(deps, INPUT_WITH_WAMID);
    await expect(
      sendOptions()?.persistInTx?.({}, { wamid: 'wamid-out-1', contactId: CONTACT_ID }),
    ).resolves.toBeUndefined();

    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, wamid: 'wamid-out-1' }),
      'ai_reply_usage_not_persisted reason=TABLE_MISSING',
    );
  });

  it('(p) a response without usage or answering model still persists zeros and "unknown"', async () => {
    const deps = makeAppDeps();
    deps.llm = createFakeLlmAdapter([ok({ text: 'hola', toolUses: [], stopReason: 'end_turn' })]);

    await runAiReply(deps, INPUT);
    await sendOptions()?.persistInTx?.({}, { wamid: 'wamid-out-1', contactId: CONTACT_ID });

    const record = mockInsertAiReplyUsageTx.mock.calls[0]?.[2];
    expect(record).toEqual(
      expect.objectContaining({
        provider: 'unknown',
        model: 'unknown',
        inboundWamid: null,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: null,
        cachedInputTokens: null,
        totalTokens: 0,
        llmCalls: 1,
        fallbackAttempts: [],
      }),
    );
  });
});
