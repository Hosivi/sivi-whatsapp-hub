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
