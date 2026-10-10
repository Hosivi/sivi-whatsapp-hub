/**
 * llm-adapter.unit.test.ts — Unit tests for createFakeLlmAdapter, createAnthropicAdapter
 * (type-check only), and createGeminiAdapter (stub-injected, no real API call).
 *
 * Exercises:
 * - createFakeLlmAdapter: default response, queueResponse, calls[], script array.
 * - createAnthropicAdapter: TypeScript compilation only (no real Anthropic call).
 * - createGeminiAdapter: text response mapping, functionCall mapping, error handling,
 *   apiKey not leaked into generate params, LlmAdapter type-check, Gemini 3
 *   thoughtSignature preservation across tool-use turns, and the ordered model
 *   fallback chain (retryable statuses, per-attempt timeout, tool-use affinity).
 *
 * STRICT TDD MODE — Gemini adapter tests written RED before implementation.
 */

import { ApiError } from '@google/genai';
import type { Content, GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import type { GeminiChainFailure, LlmAdapter } from '../../src/ai/llm-adapter.js';
import {
  createAnthropicAdapter,
  createFakeLlmAdapter,
  createGeminiAdapter,
} from '../../src/ai/llm-adapter.js';
import type { LlmMessage } from '../../src/ai/llm-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYS = 'You are a helpful assistant.';
const MSGS = [{ role: 'user' as const, content: 'Hola' }];
const TOOLS: never[] = [];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createFakeLlmAdapter', () => {
  it('(a) default response is ok with fake reply text', async () => {
    const fake = createFakeLlmAdapter();
    const result = await fake.complete(SYS, MSGS, TOOLS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value.text).toBe('fake reply');
    expect(result.value.toolUses).toEqual([]);
    expect(result.value.stopReason).toBe('end_turn');
  });

  it('(b) queueResponse overrides next call, then reverts to default', async () => {
    const fake = createFakeLlmAdapter();
    fake.queueResponse({ ok: false, error: { code: 'LLM_API_ERROR', detail: 'test' } });
    const first = await fake.complete(SYS, MSGS, TOOLS);
    expect(first.ok).toBe(false);
    // Second call — queue exhausted, back to default
    const second = await fake.complete(SYS, MSGS, TOOLS);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('never');
    expect(second.value.text).toBe('fake reply');
  });

  it('(c) calls[] records each invocation in order', async () => {
    const fake = createFakeLlmAdapter();
    await fake.complete(SYS, MSGS, TOOLS);
    await fake.complete('sys2', [{ role: 'user', content: 'Adios' }], TOOLS);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.system).toBe(SYS);
    expect(fake.calls[1]?.system).toBe('sys2');
  });

  it('(d) script array: dequeues in order, wraps to default after exhaustion', async () => {
    const r1 = {
      ok: true as const,
      value: { text: 'resp1', toolUses: [] as const, stopReason: 'end_turn' as const },
    };
    const fake = createFakeLlmAdapter([r1]);
    const first = await fake.complete(SYS, MSGS, TOOLS);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('never');
    expect(first.value.text).toBe('resp1');
    // Script exhausted → default
    const second = await fake.complete(SYS, MSGS, TOOLS);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('never');
    expect(second.value.text).toBe('fake reply');
  });

  it('(e) satisfies LlmAdapter interface (compile-time check)', () => {
    const fake: LlmAdapter = createFakeLlmAdapter();
    expect(fake).toBeDefined();
  });
});

describe('createAnthropicAdapter (type-check only)', () => {
  it('(a) createAnthropicAdapter type-checks and returns an LlmAdapter', () => {
    // We only verify TypeScript compilation — no real API call made.
    const adapter: LlmAdapter = createAnthropicAdapter('sk-fake-key', 'claude-haiku-4-5');
    expect(adapter).toBeDefined();
    expect(typeof adapter.complete).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// createGeminiAdapter — STRICT TDD, RED written before implementation
// Stubs the generate function so no real Gemini API is called.
// ---------------------------------------------------------------------------

/** Minimal stub for the Gemini generate function. */
function makeGeminiStub(candidates: unknown[]) {
  return async (_params: GenerateContentParameters): Promise<GenerateContentResponse> =>
    ({ candidates }) as unknown as GenerateContentResponse;
}

describe('createGeminiAdapter (stub-injected — no real API call)', () => {
  it('(a) text-only response → ok({ text, toolUses: [], stopReason: "end_turn" })', async () => {
    const stub = makeGeminiStub([
      { content: { parts: [{ text: 'Hola desde Gemini' }] }, finishReason: 'STOP' },
    ]);
    const adapter = createGeminiAdapter('sk-test', 'gemini-2.5-flash', stub);
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value.text).toBe('Hola desde Gemini');
    expect(result.value.toolUses).toEqual([]);
    expect(result.value.stopReason).toBe('end_turn');
  });

  it('(b) functionCall response → ok with ToolUseBlock (name + input mapped)', async () => {
    const stub = makeGeminiStub([
      {
        content: {
          parts: [
            { functionCall: { id: 'fc-001', name: 'getBusinessInfo', args: { query: 'hours' } } },
          ],
        },
        finishReason: 'STOP',
      },
    ]);
    const adapter = createGeminiAdapter('sk-test', 'gemini-2.5-flash', stub);
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value.text).toBeNull();
    expect(result.value.toolUses).toHaveLength(1);
    expect(result.value.toolUses[0]).toEqual({
      id: 'fc-001',
      name: 'getBusinessInfo',
      input: { query: 'hours' },
      producerModel: 'gemini-2.5-flash',
    });
    expect(result.value.stopReason).toBe('tool_use');
  });

  it('(c) SDK error → err(LlmError) WITHOUT throwing', async () => {
    const throwingStub = async (
      _params: GenerateContentParameters,
    ): Promise<GenerateContentResponse> => {
      throw new Error('Simulated network timeout');
    };
    const adapter = createGeminiAdapter('sk-test', 'gemini-2.5-flash', throwingStub);
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('never');
    expect(result.error.code).toBe('LLM_NETWORK_ERROR');
  });

  it('(d) apiKey is never present in the generate call parameters', async () => {
    const receivedParams: GenerateContentParameters[] = [];
    const capturingStub = async (
      params: GenerateContentParameters,
    ): Promise<GenerateContentResponse> => {
      receivedParams.push(params);
      return makeGeminiStub([{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }])(
        params,
      );
    };
    const adapter = createGeminiAdapter('SUPER_SECRET_KEY', 'gemini-2.5-flash', capturingStub);
    await adapter.complete(SYS, MSGS, TOOLS);
    // The apiKey must NEVER appear in the call parameters (it binds to the SDK client, not the params)
    const paramsJson = JSON.stringify(receivedParams);
    expect(paramsJson).not.toContain('SUPER_SECRET_KEY');
  });

  it('(e) createGeminiAdapter type-checks against LlmAdapter interface', () => {
    const adapter: LlmAdapter = createGeminiAdapter('sk-test', 'gemini-2.5-flash');
    expect(adapter).toBeDefined();
    expect(typeof adapter.complete).toBe('function');
  });

  it('(f) tool message sends toolName (not toolUseId) as Gemini functionResponse.name', async () => {
    // RED: fails until LlmMessage tool role includes toolName and mapGeminiMessages uses it.
    const receivedParams: GenerateContentParameters[] = [];
    const capturingStub = async (
      params: GenerateContentParameters,
    ): Promise<GenerateContentResponse> => {
      receivedParams.push(params);
      return makeGeminiStub([{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }])(
        params,
      );
    };

    const adapter = createGeminiAdapter('sk-test', 'gemini-2.5-flash', capturingStub);

    // A tool result message — toolUseId and toolName are DIFFERENT values.
    const toolMsg: LlmMessage = {
      role: 'tool',
      toolUseId: 'fc-001',
      toolName: 'getBusinessInfo',
      content: JSON.stringify({ business_name: 'Test Store' }),
    };

    await adapter.complete(SYS, [toolMsg], TOOLS);

    const params = receivedParams[0]!;
    const contents = params.contents as Content[];
    const toolContent = contents.find(
      (c) => Array.isArray(c.parts) && c.parts.some((p) => p.functionResponse !== undefined),
    );
    expect(toolContent).toBeDefined();
    const funcResponse = toolContent!.parts![0]!.functionResponse!;
    // Must use toolName ('getBusinessInfo'), NOT toolUseId ('fc-001')
    expect(funcResponse.name).toBe('getBusinessInfo');
    expect(funcResponse.id).toBe('fc-001');
  });
});

// ---------------------------------------------------------------------------
// createGeminiAdapter — thought signatures (Gemini 3.x)
// Gemini 3 rejects a follow-up request (400 "Function call is missing a
// thought_signature") unless the opaque Part.thoughtSignature returned on a
// functionCall part is echoed back unchanged on that same part in the history.
// In parallel calls only the first functionCall part carries a signature, so it
// must be preserved per part, never copied onto siblings.
// ---------------------------------------------------------------------------

describe('createGeminiAdapter — thought signatures', () => {
  /** Stub that records every request and replies with the queued candidates in order. */
  function makeScriptedStub(responses: unknown[][]) {
    const received: GenerateContentParameters[] = [];
    const queue = [...responses];
    const fn = async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
      received.push(params);
      const candidates = queue.shift() ?? [
        { content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
      ];
      return { candidates } as unknown as GenerateContentResponse;
    };
    return { fn, received };
  }

  /** Returns the functionCall parts of the first 'model' content in the request ([] if none). */
  function modelFunctionCallParts(params: GenerateContentParameters | undefined) {
    const contents = (params?.contents ?? []) as Content[];
    const modelTurn = contents.find(
      (c) => c.role === 'model' && (c.parts ?? []).some((p) => p.functionCall !== undefined),
    );
    return (modelTurn?.parts ?? []).filter((p) => p.functionCall !== undefined);
  }

  it('(g) functionCall part with thoughtSignature → ToolUseBlock carries it', async () => {
    const stub = makeGeminiStub([
      {
        content: {
          parts: [
            {
              functionCall: { id: 'fc-001', name: 'getBusinessInfo', args: { query: 'hours' } },
              thoughtSignature: 'c2lnLW9uZQ==',
            },
          ],
        },
        finishReason: 'STOP',
      },
    ]);
    const adapter = createGeminiAdapter('sk-test', 'gemini-3.5-flash', stub);
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value.toolUses).toEqual([
      {
        id: 'fc-001',
        name: 'getBusinessInfo',
        input: { query: 'hours' },
        thoughtSignature: 'c2lnLW9uZQ==',
        producerModel: 'gemini-3.5-flash',
      },
    ]);
  });

  it('(h) round-trip: the signature is re-emitted on the same functionCall part, per part', async () => {
    // Turn 1: parallel calls — only the FIRST functionCall part carries a signature.
    const { fn, received } = makeScriptedStub([
      [
        {
          content: {
            parts: [
              {
                functionCall: { id: 'fc-001', name: 'getBusinessInfo', args: {} },
                thoughtSignature: 'c2lnLW9uZQ==',
              },
              { functionCall: { id: 'fc-002', name: 'getPrices', args: { sku: 'A1' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    ]);
    const adapter = createGeminiAdapter('sk-test', 'gemini-3.5-flash', fn);

    const first = await adapter.complete(SYS, MSGS, TOOLS);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('never');

    // Turn 2: history carries the tool-use turn exactly as the adapter returned it.
    const history: LlmMessage[] = [
      ...MSGS,
      { role: 'assistant-tool-use', toolUses: first.value.toolUses },
      { role: 'tool', toolUseId: 'fc-001', toolName: 'getBusinessInfo', content: '{"ok":true}' },
      { role: 'tool', toolUseId: 'fc-002', toolName: 'getPrices', content: '{"price":10}' },
    ];
    await adapter.complete(SYS, history, TOOLS);

    expect(received).toHaveLength(2);
    // Part-level field, sibling of functionCall (matches @google/genai Part).
    // toStrictEqual also fails if the second part carries `thoughtSignature: undefined`.
    expect(modelFunctionCallParts(received[1])).toStrictEqual([
      {
        functionCall: { id: 'fc-001', name: 'getBusinessInfo', args: {} },
        thoughtSignature: 'c2lnLW9uZQ==',
      },
      { functionCall: { id: 'fc-002', name: 'getPrices', args: { sku: 'A1' } } },
    ]);
  });

  it('(i) blocks without a signature → no thoughtSignature on ToolUseBlock nor on parts', async () => {
    const { fn, received } = makeScriptedStub([
      [
        {
          content: {
            parts: [{ functionCall: { id: 'fc-001', name: 'getBusinessInfo', args: {} } }],
          },
          finishReason: 'STOP',
        },
      ],
    ]);
    const adapter = createGeminiAdapter('sk-test', 'gemini-2.5-flash', fn);

    const first = await adapter.complete(SYS, MSGS, TOOLS);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('never');
    expect(first.value.toolUses).toStrictEqual([
      { id: 'fc-001', name: 'getBusinessInfo', input: {}, producerModel: 'gemini-2.5-flash' },
    ]);

    await adapter.complete(
      SYS,
      [...MSGS, { role: 'assistant-tool-use', toolUses: first.value.toolUses }],
      TOOLS,
    );
    expect(modelFunctionCallParts(received[1])).toStrictEqual([
      { functionCall: { id: 'fc-001', name: 'getBusinessInfo', args: {} } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// createGeminiAdapter — ordered model fallback chain
// Each attempt is scripted per model (the stub reads params.model). Retryable
// failures (404/429/5xx, per-attempt timeout, network error without status)
// move to the next model; deterministic ones (400/401/403) return immediately.
// ---------------------------------------------------------------------------

type ModelOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'toolCall'; readonly signature?: string }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'network' }
  | { readonly kind: 'hang' };

/**
 * Stub that dequeues the next scripted outcome for params.model on every call.
 * Unscripted calls answer with text `from <model>`. 'hang' never resolves on its
 * own: it only rejects once the attempt's abort signal fires.
 */
function makeModelStub(script: Record<string, ModelOutcome[]>) {
  const calls: string[] = [];
  const received: GenerateContentParameters[] = [];
  const queues = new Map(Object.entries(script).map(([model, outcomes]) => [model, [...outcomes]]));
  const fn = async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
    calls.push(params.model);
    received.push(params);
    const outcome: ModelOutcome = queues.get(params.model)?.shift() ?? {
      kind: 'text',
      text: `from ${params.model}`,
    };
    switch (outcome.kind) {
      case 'status':
        throw new ApiError({ message: `HTTP ${outcome.status}`, status: outcome.status });
      case 'network':
        throw new TypeError('fetch failed');
      case 'hang':
        return new Promise<GenerateContentResponse>((_resolve, reject) => {
          params.config?.abortSignal?.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        });
      case 'toolCall':
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: 'fc-001', name: 'getBusinessInfo', args: {} },
                    ...(outcome.signature !== undefined
                      ? { thoughtSignature: outcome.signature }
                      : {}),
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      case 'text':
        return {
          candidates: [{ content: { parts: [{ text: outcome.text }] }, finishReason: 'STOP' }],
        } as unknown as GenerateContentResponse;
    }
  };
  return { fn, calls, received };
}

/** Narrows a failed result to its chain-failure cause (attempts + lastError). */
function chainFailureOf(result: Awaited<ReturnType<LlmAdapter['complete']>>): GeminiChainFailure {
  if (result.ok) throw new Error('expected a failed result');
  if (result.error.code !== 'LLM_NETWORK_ERROR') {
    throw new Error(`expected LLM_NETWORK_ERROR, got ${result.error.code}`);
  }
  return result.error.cause as GeminiChainFailure;
}

describe('createGeminiAdapter — model fallback chain', () => {
  const CHAIN = ['m-lite', 'm-flash', 'm-pro'] as const;

  it.each([[404], [429], [500], [502], [503], [504]])(
    'HTTP %i on the first model → falls back and answers with the next model',
    async (status) => {
      const stub = makeModelStub({ 'm-lite': [{ kind: 'status', status }] });
      const adapter = createGeminiAdapter('sk-test', CHAIN, stub.fn);
      const result = await adapter.complete(SYS, MSGS, TOOLS);
      expect(stub.calls).toEqual(['m-lite', 'm-flash']);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('never');
      expect(result.value.text).toBe('from m-flash');
    },
  );

  it('a timed-out attempt is aborted and falls back to the next model', async () => {
    const stub = makeModelStub({ 'm-lite': [{ kind: 'hang' }] });
    const adapter = createGeminiAdapter('sk-test', CHAIN, stub.fn, { timeoutMs: 20 });
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    expect(stub.calls).toEqual(['m-lite', 'm-flash']);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value.text).toBe('from m-flash');
    // The SDK abort signal of the timed-out attempt fired; the next attempt has its own.
    expect(stub.received[0]?.config?.abortSignal?.aborted).toBe(true);
    expect(stub.received[1]?.config?.abortSignal?.aborted).toBe(false);
  }, 2_000);

  it('a network error without HTTP status falls back to the next model', async () => {
    const stub = makeModelStub({ 'm-lite': [{ kind: 'network' }] });
    const adapter = createGeminiAdapter('sk-test', CHAIN, stub.fn);
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    expect(stub.calls).toEqual(['m-lite', 'm-flash']);
    expect(result.ok).toBe(true);
  });

  it.each([[400], [401], [403]])(
    'HTTP %i is deterministic → returns immediately, no fallback, no fallback log',
    async (status) => {
      const warn = vi.fn();
      const stub = makeModelStub({ 'm-lite': [{ kind: 'status', status }] });
      const adapter = createGeminiAdapter('sk-test', CHAIN, stub.fn, { logger: { warn } });
      const result = await adapter.complete(SYS, MSGS, TOOLS);
      expect(stub.calls).toEqual(['m-lite']);
      expect(chainFailureOf(result).attempts).toEqual([
        { model: 'm-lite', reason: 'http_error', status },
      ]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('all models fail → LLM_NETWORK_ERROR whose cause keeps the last error and every attempt', async () => {
    const stub = makeModelStub({
      'm-lite': [{ kind: 'status', status: 503 }],
      'm-flash': [{ kind: 'hang' }],
      'm-pro': [{ kind: 'status', status: 404 }],
    });
    const adapter = createGeminiAdapter('sk-test', CHAIN, stub.fn, { timeoutMs: 20 });
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    expect(stub.calls).toEqual(['m-lite', 'm-flash', 'm-pro']);
    const failure = chainFailureOf(result);
    expect(failure.attempts).toEqual([
      { model: 'm-lite', reason: 'http_error', status: 503 },
      { model: 'm-flash', reason: 'timeout', status: null },
      { model: 'm-pro', reason: 'http_error', status: 404 },
    ]);
    expect(failure.lastError).toBeInstanceOf(ApiError);
    expect((failure.lastError as ApiError).status).toBe(404);
  }, 2_000);

  it('logs every fallback as warn llm_model_fallback with models, status and reason only', async () => {
    const warn = vi.fn();
    const stub = makeModelStub({
      'm-lite': [{ kind: 'status', status: 503 }],
      'm-flash': [{ kind: 'hang' }],
    });
    const adapter = createGeminiAdapter('SUPER_SECRET_KEY', CHAIN, stub.fn, {
      timeoutMs: 20,
      logger: { warn },
    });
    const customerText = 'Hola, mi DNI es 44556677';
    const result = await adapter.complete(
      'SYSTEM_PROMPT_SENTINEL',
      [{ role: 'user', content: customerText }],
      TOOLS,
    );
    expect(result.ok).toBe(true);
    expect(warn.mock.calls).toEqual([
      [
        { fromModel: 'm-lite', toModel: 'm-flash', status: 503, reason: 'http_error' },
        'llm_model_fallback',
      ],
      [
        { fromModel: 'm-flash', toModel: 'm-pro', status: null, reason: 'timeout' },
        'llm_model_fallback',
      ],
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('SUPER_SECRET_KEY');
    expect(logged).not.toContain('SYSTEM_PROMPT_SENTINEL');
    expect(logged).not.toContain(customerText);
  }, 2_000);

  it('no fallback log when the last model fails (there is no next model)', async () => {
    const warn = vi.fn();
    const stub = makeModelStub({ only: [{ kind: 'status', status: 503 }] });
    const adapter = createGeminiAdapter('sk-test', 'only', stub.fn, { logger: { warn } });
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    expect(chainFailureOf(result).attempts).toEqual([
      { model: 'only', reason: 'http_error', status: 503 },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tool-use follow-up tries the model that produced the tool call first, then the rest in order', async () => {
    const stub = makeModelStub({
      'm-lite': [{ kind: 'status', status: 503 }],
      'm-flash': [
        { kind: 'toolCall', signature: 'c2lnLWZsYXNo' },
        { kind: 'status', status: 503 },
      ],
    });
    const adapter = createGeminiAdapter('sk-test', CHAIN, stub.fn);

    const first = await adapter.complete(SYS, MSGS, TOOLS);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('never');
    expect(first.value.toolUses).toStrictEqual([
      {
        id: 'fc-001',
        name: 'getBusinessInfo',
        input: {},
        thoughtSignature: 'c2lnLWZsYXNo',
        producerModel: 'm-flash',
      },
    ]);

    const history: LlmMessage[] = [
      ...MSGS,
      { role: 'assistant-tool-use', toolUses: first.value.toolUses },
      { role: 'tool', toolUseId: 'fc-001', toolName: 'getBusinessInfo', content: '{"ok":true}' },
    ];
    const second = await adapter.complete(SYS, history, TOOLS);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('never');
    expect(second.value.text).toBe('from m-lite');
    // Turn 1: m-lite 503 → m-flash. Turn 2: m-flash first (affinity) 503 → m-lite.
    expect(stub.calls).toEqual(['m-lite', 'm-flash', 'm-flash', 'm-lite']);
    // The signature is replayed unchanged (never stripped nor invented) on the fallback attempt.
    const replayed = (stub.received[3]?.contents as Content[])
      .flatMap((c) => c.parts ?? [])
      .find((part) => part.functionCall !== undefined);
    expect(replayed?.thoughtSignature).toBe('c2lnLWZsYXNo');
    // The provider-opaque producerModel never leaks into the request parts.
    expect(JSON.stringify(stub.received[3]?.contents)).not.toContain('producerModel');
  });

  it('ignores a producer model that is not in the configured chain', async () => {
    const stub = makeModelStub({});
    const adapter = createGeminiAdapter('sk-test', CHAIN, stub.fn);
    const history: LlmMessage[] = [
      ...MSGS,
      {
        role: 'assistant-tool-use',
        toolUses: [
          { id: 'fc-001', name: 'getBusinessInfo', input: {}, producerModel: 'm-retired' },
        ],
      },
      { role: 'tool', toolUseId: 'fc-001', toolName: 'getBusinessInfo', content: '{}' },
    ];
    await adapter.complete(SYS, history, TOOLS);
    expect(stub.calls).toEqual(['m-lite']);
  });

  it('normalizes the list form: trims, drops empty entries and duplicates', async () => {
    const stub = makeModelStub({ 'm-lite': [{ kind: 'status', status: 503 }] });
    const adapter = createGeminiAdapter('sk-test', [' m-lite ', '', 'm-lite', 'm-flash'], stub.fn);
    await adapter.complete(SYS, MSGS, TOOLS);
    expect(stub.calls).toEqual(['m-lite', 'm-flash']);
  });

  it('fails fast at construction when no model is configured', () => {
    const stub = makeModelStub({});
    expect(() => createGeminiAdapter('sk-test', [' ', ''], stub.fn)).toThrow(/at least one model/);
  });
});

// ---------------------------------------------------------------------------
// Token usage + answering model (ai-usage-visibility T1)
// ---------------------------------------------------------------------------

describe('createGeminiAdapter — token usage and answering model', () => {
  /** Generate stub answering with text plus the given extra response fields. */
  const answerWith =
    (extra: Record<string, unknown>) =>
    async (_params: GenerateContentParameters): Promise<GenerateContentResponse> =>
      ({
        candidates: [{ content: { parts: [{ text: 'hola' }] }, finishReason: 'STOP' }],
        ...extra,
      }) as unknown as GenerateContentResponse;

  it('maps usageMetadata: input = prompt + tool-use prompt, output = candidates + thoughts', async () => {
    const adapter = createGeminiAdapter(
      'sk-test',
      'gemini-3.5-flash',
      answerWith({
        usageMetadata: {
          promptTokenCount: 120,
          toolUsePromptTokenCount: 5,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 12,
          cachedContentTokenCount: 40,
          totalTokenCount: 167,
        },
      }),
    );
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.usage).toStrictEqual({
      inputTokens: 125,
      outputTokens: 42,
      reasoningTokens: 12,
      cachedInputTokens: 40,
      totalTokens: 167,
    });
    expect(result.value.answeredBy).toStrictEqual({
      provider: 'gemini',
      model: 'gemini-3.5-flash',
    });
  });

  it('no usageMetadata → usage is undefined (never throws)', async () => {
    const adapter = createGeminiAdapter('sk-test', 'gemini-3.5-flash', answerWith({}));
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.usage).toBeUndefined();
    expect(result.value.text).toBe('hola');
  });

  it('partial usageMetadata → missing counts are 0 or omitted; total falls back to input + output', async () => {
    const adapter = createGeminiAdapter(
      'sk-test',
      'gemini-3.5-flash',
      answerWith({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } }),
    );
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.usage).toStrictEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  });

  it('usageMetadata without any valid count → usage is undefined', async () => {
    const adapter = createGeminiAdapter(
      'sk-test',
      'gemini-3.5-flash',
      answerWith({ usageMetadata: { promptTokenCount: 'x', totalTokenCount: -1 } }),
    );
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.usage).toBeUndefined();
  });

  it('after an internal fallback, answeredBy names the model that answered', async () => {
    const stub = makeModelStub({ 'm-lite': [{ kind: 'status', status: 503 }] });
    const adapter = createGeminiAdapter('sk-test', ['m-lite', 'm-flash'], stub.fn);
    const result = await adapter.complete(SYS, MSGS, TOOLS);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.answeredBy).toStrictEqual({ provider: 'gemini', model: 'm-flash' });
  });
});
