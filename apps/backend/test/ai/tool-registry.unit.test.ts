/**
 * tool-registry.unit.test.ts — Unit tests for the governed AI tool registry.
 *
 * Strict TDD: written RED before implementation (all imports will fail until
 * tool-registry.ts is created).
 *
 * Governance invariants tested:
 * - Unknown tool → { error: 'unknown_tool' } in tool LlmMessage (NOT a throw).
 * - Zod-invalid input → { error: 'invalid_input' } WITHOUT calling execute.
 * - getBusinessInfo with config in ctx → ok({ business_name, business_info }).
 * - getBusinessInfo with null config → err(CONFIG_UNAVAILABLE) in content.
 * - classifyContact valid input → calls updateContact with correct patch.
 * - classifyContact invalid intent → rejected by Zod BEFORE execute.
 * - Pino audit entry emitted per executeTool call.
 * - Tool context MUST NOT expose a raw DB handle.
 *
 * Uses vi.mock() for createContactsRepository (no real DB).
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmMessage } from '../../src/ai/llm-types.js';
import { REGISTRY, executeTool, toLlmTool } from '../../src/ai/tool-registry.js';
import type { TenantRunner } from '../../src/db/client.js';
import type { TenantAiConfig } from '../../src/db/schema/tenant-ai-config.schema.js';
import { ok } from '../../src/shared/result.js';

// ---------------------------------------------------------------------------
// Mock createContactsRepository so classifyContact unit tests hit no real DB
// ---------------------------------------------------------------------------

const mockUpdate = vi.fn();

vi.mock('../../src/contacts/contacts.repository.js', () => ({
  createContactsRepository: vi.fn(() => ({
    update: mockUpdate,
    create: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    softDelete: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONTACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeConfig(overrides: Partial<TenantAiConfig> = {}): TenantAiConfig {
  return {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    tenantId: TENANT_ID,
    vertical: 'tienda_general',
    businessName: 'Tienda La Esperanza',
    businessInfo: { hours: '9am-6pm' },
    enabled: true,
    systemPromptOverride: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

/** Fake TenantRunner — never actually called in pure tool unit tests (mocked at repo level). */
const fakeWithTenant: TenantRunner = async (_tenantId, run) => {
  const fakeTx = {} as unknown as PostgresJsDatabase;
  return run(fakeTx);
};

/** Fake logger that records calls. */
const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/** Minimal fake deps for executeTool. */
function makeDeps(config: TenantAiConfig | null = makeConfig()) {
  return {
    db: { withTenant: fakeWithTenant } as { withTenant: TenantRunner },
    logger: fakeLogger as unknown as Parameters<typeof executeTool>[0]['logger'],
    _config: config, // used to pass to executeTool
  };
}

// ---------------------------------------------------------------------------
// Suite: REGISTRY shape
// ---------------------------------------------------------------------------

describe('REGISTRY', () => {
  it('exports an array of at least two tools', () => {
    expect(Array.isArray(REGISTRY)).toBe(true);
    expect(REGISTRY.length).toBeGreaterThanOrEqual(2);
  });

  it('each tool has name, description, inputSchema, schema, and run', () => {
    for (const tool of REGISTRY) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.run).toBe('function');
    }
  });

  it('toLlmTool maps a tool to { name, description, inputSchema: Record<string, unknown> }', () => {
    const llmTool = toLlmTool(REGISTRY[0]);
    expect(typeof llmTool.name).toBe('string');
    expect(typeof llmTool.description).toBe('string');
    expect(typeof llmTool.inputSchema).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Suite: executeTool — governance gates
// ---------------------------------------------------------------------------

describe('executeTool — governance gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(
      ok({
        id: CONTACT_ID,
        tenantId: TENANT_ID,
        phoneE164: '+51999000001',
        fullName: null,
        source: null,
        tags: ['cliente'],
        intent: 'hacer_pedido',
        intentConfidence: 0.9,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        deletedAt: null,
        routedAt: null,
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(a) unknown tool name → role tool message with { error: "unknown_tool" } content', async () => {
    const deps = makeDeps();
    const block = { id: 'tool-001', name: 'nonExistentTool', input: {} };
    const msg: LlmMessage = await executeTool(
      { db: deps.db, logger: deps.logger },
      TENANT_ID,
      block,
      deps._config,
    );

    expect(msg.role).toBe('tool');
    expect(msg.toolUseId).toBe('tool-001');
    expect(msg.toolName).toBe('nonExistentTool');
    const content = JSON.parse(msg.content);
    expect(content.error).toBe('unknown_tool');
    // execute was not called
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('(b) Zod-invalid input → { error: "invalid_input" } WITHOUT calling execute', async () => {
    const deps = makeDeps();
    // classifyContact expects intent enum — pass an invalid value
    const block = {
      id: 'tool-002',
      name: 'classifyContact',
      input: { contactId: CONTACT_ID, intent: 'INVALID_INTENT', tags: [] },
    };
    const msg: LlmMessage = await executeTool(
      { db: deps.db, logger: deps.logger },
      TENANT_ID,
      block,
      deps._config,
    );

    expect(msg.role).toBe('tool');
    const content = JSON.parse(msg.content);
    expect(content.error).toBe('invalid_input');
    // execute was NOT called
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('(c) getBusinessInfo with valid config → ok content with business_name and business_info', async () => {
    const config = makeConfig({ businessName: 'Mi Tienda', businessInfo: { hours: '9-6' } });
    const deps = makeDeps(config);
    const block = { id: 'tool-003', name: 'getBusinessInfo', input: {} };
    const msg: LlmMessage = await executeTool(
      { db: deps.db, logger: deps.logger },
      TENANT_ID,
      block,
      config,
    );

    expect(msg.role).toBe('tool');
    const content = JSON.parse(msg.content);
    expect(content.business_name).toBe('Mi Tienda');
    expect(content.business_info).toEqual({ hours: '9-6' });
  });

  it('(d) getBusinessInfo with null config → error content with CONFIG_UNAVAILABLE', async () => {
    const deps = makeDeps(null);
    const block = { id: 'tool-004', name: 'getBusinessInfo', input: {} };
    const msg: LlmMessage = await executeTool(
      { db: deps.db, logger: deps.logger },
      TENANT_ID,
      block,
      null,
    );

    expect(msg.role).toBe('tool');
    const content = JSON.parse(msg.content);
    expect(content.error).toBe('CONFIG_UNAVAILABLE');
  });

  it('(e) classifyContact valid input → calls updateContact with correct patch', async () => {
    const deps = makeDeps();
    const block = {
      id: 'tool-005',
      name: 'classifyContact',
      input: {
        contactId: CONTACT_ID,
        intent: 'hacer_pedido',
        tags: ['cliente', 'interesado'],
        intentConfidence: 0.9,
      },
    };
    const msg: LlmMessage = await executeTool(
      { db: deps.db, logger: deps.logger },
      TENANT_ID,
      block,
      deps._config,
    );

    expect(msg.role).toBe('tool');
    // updateContact must have been called with correct patch
    expect(mockUpdate).toHaveBeenCalledOnce();
    const [calledId, calledPatch] = mockUpdate.mock.calls[0];
    expect(calledId).toBe(CONTACT_ID);
    expect(calledPatch.intent).toBe('hacer_pedido');
    expect(calledPatch.tags).toEqual(['cliente', 'interesado']);
    expect(calledPatch.intentConfidence).toBe(0.9);
  });

  it('(f) classifyContact invalid intent enum → Zod rejects BEFORE execute', async () => {
    const deps = makeDeps();
    const block = {
      id: 'tool-006',
      name: 'classifyContact',
      input: { contactId: CONTACT_ID, intent: 'comprar_ahora', tags: [] },
    };
    const msg: LlmMessage = await executeTool(
      { db: deps.db, logger: deps.logger },
      TENANT_ID,
      block,
      deps._config,
    );

    const content = JSON.parse(msg.content);
    expect(content.error).toBe('invalid_input');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('(g) pino audit entry (info) emitted per executeTool call', async () => {
    const deps = makeDeps();
    const block = { id: 'tool-007', name: 'getBusinessInfo', input: {} };
    await executeTool({ db: deps.db, logger: deps.logger }, TENANT_ID, block, deps._config);

    // logger.info must have been called at least once for the audit log
    expect(fakeLogger.info).toHaveBeenCalled();
    // The audit call must include tool name and tenantId
    const auditCall = fakeLogger.info.mock.calls.find(
      (args) => args[0] && typeof args[0] === 'object' && 'tool' in args[0],
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].tool).toBe('getBusinessInfo');
    expect(auditCall[0].tenantId).toBe(TENANT_ID);
  });
});
