/**
 * model-chain.unit.test.ts — createModelChainLlm: the ordered cross-provider
 * (Gemini + OpenAI) model chain.
 *
 * Uses the REAL provider adapters with injected stubs (Gemini generate function,
 * OpenAI fetch) so the chain classifies the errors those adapters really return.
 * No network, no real API keys.
 *
 * Exercises: T4 classification across providers (fall back on 404/408/429/5xx,
 * timeout, network, bad response; stop on 400/401/403), `llm_model_fallback`
 * logging with provider:model labels, the T4-shaped all-failed error, tool-use
 * model affinity across providers, cross-provider history replay, and wiring-time
 * validation.
 */

import { ApiError } from '@google/genai';
import type { Content, GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { createGeminiAdapter } from '../../src/ai/llm-adapter.js';
import type { LlmAdapter } from '../../src/ai/llm-adapter.js';
import type { LlmMessage, LlmModelEntry } from '../../src/ai/llm-types.js';
import { createModelChainLlm } from '../../src/ai/model-chain.js';
import type { ModelChainFailure } from '../../src/ai/model-chain.js';
import { createOpenAiAdapter } from '../../src/ai/openai-adapter.js';
import type { OpenAiFetch } from '../../src/ai/openai-adapter.js';
import { err } from '../../src/shared/result.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GEMINI_KEY = 'GEMINI-SECRET-SENTINEL';
const OPENAI_KEY = 'sk-OPENAI-SECRET-SENTINEL';
const SYS = 'SYSTEM_PROMPT_SENTINEL';
const CUSTOMER_TEXT = 'Hola, mi DNI es 44556677';
const MSGS: LlmMessage[] = [{ role: 'user', content: CUSTOMER_TEXT }];

const gemini = (model: string): LlmModelEntry => ({ provider: 'gemini', model });
const openai = (model: string): LlmModelEntry => ({ provider: 'openai', model });

type GeminiOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'hang' }
  | { readonly kind: 'toolCall'; readonly id: string; readonly signature?: string };

type OpenAiOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'status'; readonly status: number; readonly code?: string }
  | { readonly kind: 'hang' }
  | { readonly kind: 'network' }
  | { readonly kind: 'toolCall'; readonly id: string; readonly args?: string };

type Script = {
  readonly gemini?: Record<string, GeminiOutcome[]>;
  readonly openai?: Record<string, OpenAiOutcome[]>;
};

/**
 * Builds a chain over real adapters whose transports are stubbed. Unscripted
 * calls answer with text `from <provider>:<model>`. `calls` records every
 * attempt as provider:model in the order it ran.
 */
function makeHarness(script: Script = {}) {
  const calls: string[] = [];
  const geminiRequests: GenerateContentParameters[] = [];
  const openaiBodies: Array<Record<string, unknown>> = [];
  const geminiQueues = new Map(Object.entries(script.gemini ?? {}).map(([m, o]) => [m, [...o]]));
  const openaiQueues = new Map(Object.entries(script.openai ?? {}).map(([m, o]) => [m, [...o]]));
  const warn = vi.fn();

  const generateFn = async (
    params: GenerateContentParameters,
  ): Promise<GenerateContentResponse> => {
    calls.push(`gemini:${params.model}`);
    geminiRequests.push(params);
    const outcome = geminiQueues.get(params.model)?.shift() ?? {
      kind: 'text',
      text: `from gemini:${params.model}`,
    };
    switch (outcome.kind) {
      case 'status':
        throw new ApiError({ message: `HTTP ${outcome.status}`, status: outcome.status });
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
                    functionCall: { id: outcome.id, name: 'getBusinessInfo', args: {} },
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

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchFn: OpenAiFetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const model = String(body.model);
    calls.push(`openai:${model}`);
    openaiBodies.push(body);
    const outcome = openaiQueues.get(model)?.shift() ?? {
      kind: 'text',
      text: `from openai:${model}`,
    };
    switch (outcome.kind) {
      case 'status':
        return json(outcome.status, {
          error: { message: `boom ${OPENAI_KEY}`, type: 'error_type', code: outcome.code ?? null },
        });
      case 'network':
        throw new TypeError('fetch failed');
      case 'hang':
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      case 'toolCall':
        return json(200, {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: outcome.id,
                    type: 'function',
                    function: { name: 'getBusinessInfo', arguments: outcome.args ?? '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      case 'text':
        return json(200, {
          choices: [
            { message: { role: 'assistant', content: outcome.text }, finish_reason: 'stop' },
          ],
        });
    }
  };

  const factoryTimeouts: Array<{ provider: string; model: string; timeoutMs: number }> = [];

  const build = (entries: readonly LlmModelEntry[], timeoutMs?: number): LlmAdapter =>
    createModelChainLlm(entries, {
      providers: {
        gemini: (model, options) => {
          factoryTimeouts.push({ provider: 'gemini', model, timeoutMs: options.timeoutMs });
          return createGeminiAdapter(GEMINI_KEY, model, generateFn, options);
        },
        openai: (model, options) => {
          factoryTimeouts.push({ provider: 'openai', model, timeoutMs: options.timeoutMs });
          return createOpenAiAdapter(OPENAI_KEY, model, { ...options, fetchFn });
        },
      },
      logger: { warn },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

  return { build, calls, warn, geminiRequests, openaiBodies, factoryTimeouts };
}

/** Narrows a failed result to its T4-shaped chain failure (attempts + lastError). */
function chainFailureOf(result: Awaited<ReturnType<LlmAdapter['complete']>>): ModelChainFailure {
  if (result.ok) throw new Error('expected a failed result');
  if (result.error.code !== 'LLM_NETWORK_ERROR') {
    throw new Error(`expected LLM_NETWORK_ERROR, got ${result.error.code}`);
  }
  return result.error.cause as ModelChainFailure;
}

const textOf = (result: Awaited<ReturnType<LlmAdapter['complete']>>): string | null => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value.text;
};

const OWNER_CHAIN = [
  gemini('gemini-3.5-flash-lite'),
  openai('gpt-6-luna'),
  gemini('gemini-3.5-flash'),
];

// ---------------------------------------------------------------------------
// Fallback classification across providers
// ---------------------------------------------------------------------------

describe('createModelChainLlm — cross-provider fallback', () => {
  it('Gemini 503 → falls back to OpenAI, which answers; the fallback is logged with provider:model labels', async () => {
    const h = makeHarness({
      gemini: { 'gemini-3.5-flash-lite': [{ kind: 'status', status: 503 }] },
    });
    const result = await h.build(OWNER_CHAIN).complete(SYS, MSGS, []);
    expect(textOf(result)).toBe('from openai:gpt-6-luna');
    expect(h.calls).toEqual(['gemini:gemini-3.5-flash-lite', 'openai:gpt-6-luna']);
    expect(h.warn.mock.calls).toEqual([
      [
        {
          fromModel: 'gemini:gemini-3.5-flash-lite',
          toModel: 'openai:gpt-6-luna',
          status: 503,
          reason: 'http_error',
        },
        'llm_model_fallback',
      ],
    ]);
  });

  it('OpenAI 429 (quota) → falls back to the next Gemini model', async () => {
    const h = makeHarness({
      openai: { 'gpt-6-luna': [{ kind: 'status', status: 429, code: 'insufficient_quota' }] },
    });
    const result = await h
      .build([openai('gpt-6-luna'), gemini('gemini-3.5-flash')])
      .complete(SYS, MSGS, []);
    expect(textOf(result)).toBe('from gemini:gemini-3.5-flash');
    expect(h.calls).toEqual(['openai:gpt-6-luna', 'gemini:gemini-3.5-flash']);
    expect(h.warn).toHaveBeenCalledWith(
      {
        fromModel: 'openai:gpt-6-luna',
        toModel: 'gemini:gemini-3.5-flash',
        status: 429,
        reason: 'http_error',
      },
      'llm_model_fallback',
    );
  });

  it('OpenAI 401 (bad key) → stops at once: no fallback, no log, T4-shaped failure without the key', async () => {
    const h = makeHarness({
      openai: { 'gpt-6-luna': [{ kind: 'status', status: 401, code: 'invalid_api_key' }] },
    });
    const result = await h
      .build([openai('gpt-6-luna'), gemini('gemini-3.5-flash')])
      .complete(SYS, MSGS, []);
    expect(h.calls).toEqual(['openai:gpt-6-luna']);
    expect(h.warn).not.toHaveBeenCalled();
    const failure = chainFailureOf(result);
    expect(failure.attempts).toEqual([
      { model: 'openai:gpt-6-luna', reason: 'http_error', status: 401 },
    ]);
    expect(failure.lastError).toEqual({
      code: 'LLM_API_ERROR',
      status: 401,
      errorType: 'error_type',
      errorCode: 'invalid_api_key',
    });
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  it.each([[400], [403]])(
    'HTTP %i is deterministic on either provider → returns immediately, no fallback log',
    async (status) => {
      const h = makeHarness({
        gemini: { 'gemini-3.5-flash-lite': [{ kind: 'status', status }] },
        openai: { 'gpt-6-luna': [{ kind: 'status', status }] },
      });
      const fromGemini = await h.build(OWNER_CHAIN).complete(SYS, MSGS, []);
      const fromOpenAi = await h.build([openai('gpt-6-luna'), gemini('m')]).complete(SYS, MSGS, []);
      expect(h.calls).toEqual(['gemini:gemini-3.5-flash-lite', 'openai:gpt-6-luna']);
      expect(chainFailureOf(fromGemini).attempts).toEqual([
        { model: 'gemini:gemini-3.5-flash-lite', reason: 'http_error', status },
      ]);
      expect(chainFailureOf(fromOpenAi).attempts).toEqual([
        { model: 'openai:gpt-6-luna', reason: 'http_error', status },
      ]);
      expect(h.warn).not.toHaveBeenCalled();
    },
  );

  it.each([[404], [408], [429], [500], [502], [503], [504]])(
    'OpenAI HTTP %i → falls back to the next model',
    async (status) => {
      const h = makeHarness({ openai: { 'gpt-6-luna': [{ kind: 'status', status }] } });
      const result = await h
        .build([openai('gpt-6-luna'), gemini('m-flash')])
        .complete(SYS, MSGS, []);
      expect(textOf(result)).toBe('from gemini:m-flash');
    },
  );

  it('an OpenAI timeout falls back with reason timeout', async () => {
    const h = makeHarness({ openai: { 'gpt-6-luna': [{ kind: 'hang' }] } });
    const result = await h
      .build([openai('gpt-6-luna'), gemini('m-flash')], 20)
      .complete(SYS, MSGS, []);
    expect(textOf(result)).toBe('from gemini:m-flash');
    expect(h.warn).toHaveBeenCalledWith(
      {
        fromModel: 'openai:gpt-6-luna',
        toModel: 'gemini:m-flash',
        status: null,
        reason: 'timeout',
      },
      'llm_model_fallback',
    );
  }, 2_000);

  it('a Gemini timeout falls back to OpenAI with reason timeout', async () => {
    const h = makeHarness({ gemini: { 'gemini-3.5-flash-lite': [{ kind: 'hang' }] } });
    const result = await h.build(OWNER_CHAIN, 20).complete(SYS, MSGS, []);
    expect(textOf(result)).toBe('from openai:gpt-6-luna');
    expect(h.warn.mock.calls[0]?.[0]).toEqual({
      fromModel: 'gemini:gemini-3.5-flash-lite',
      toModel: 'openai:gpt-6-luna',
      status: null,
      reason: 'timeout',
    });
  }, 2_000);

  it('an OpenAI network error (no HTTP status) falls back with reason network_error', async () => {
    const h = makeHarness({ openai: { 'gpt-6-luna': [{ kind: 'network' }] } });
    const result = await h.build([openai('gpt-6-luna'), gemini('m-flash')]).complete(SYS, MSGS, []);
    expect(textOf(result)).toBe('from gemini:m-flash');
    expect(h.warn.mock.calls[0]?.[0]).toMatchObject({ status: null, reason: 'network_error' });
  });

  it('malformed OpenAI tool-call arguments fall back with reason bad_response', async () => {
    const h = makeHarness({
      openai: { 'gpt-6-luna': [{ kind: 'toolCall', id: 'call_1', args: '{"broken":' }] },
    });
    const result = await h.build([openai('gpt-6-luna'), gemini('m-flash')]).complete(SYS, MSGS, []);
    expect(textOf(result)).toBe('from gemini:m-flash');
    expect(h.warn.mock.calls[0]?.[0]).toMatchObject({ status: null, reason: 'bad_response' });
  });

  it('an adapter that throws is contained and treated as a network error', async () => {
    const warn = vi.fn();
    const throwing: LlmAdapter = {
      complete: async () => {
        throw new Error('unexpected');
      },
    };
    const answering: LlmAdapter = {
      complete: async () => ({
        ok: true,
        value: { text: 'ok', toolUses: [], stopReason: 'end_turn' },
      }),
    };
    const chain = createModelChainLlm([openai('a'), gemini('b')], {
      providers: { openai: () => throwing, gemini: () => answering },
      logger: { warn },
    });
    const result = await chain.complete(SYS, MSGS, []);
    expect(textOf(result)).toBe('ok');
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ reason: 'network_error', status: null });
  });

  it('every model fails → LLM_NETWORK_ERROR with every attempt (provider:model) and the last error', async () => {
    const h = makeHarness({
      gemini: {
        'gemini-3.5-flash-lite': [{ kind: 'status', status: 503 }],
        'gemini-3.5-flash': [{ kind: 'status', status: 404 }],
      },
      openai: { 'gpt-6-luna': [{ kind: 'status', status: 429 }] },
    });
    const result = await h.build(OWNER_CHAIN).complete(SYS, MSGS, []);
    const failure = chainFailureOf(result);
    expect(failure.attempts).toEqual([
      { model: 'gemini:gemini-3.5-flash-lite', reason: 'http_error', status: 503 },
      { model: 'openai:gpt-6-luna', reason: 'http_error', status: 429 },
      { model: 'gemini:gemini-3.5-flash', reason: 'http_error', status: 404 },
    ]);
    expect(failure.lastError).toBeInstanceOf(ApiError);
    expect((failure.lastError as ApiError).status).toBe(404);
    // Two fallbacks logged; the last failure has no next model.
    expect(h.warn).toHaveBeenCalledTimes(2);
  });

  it('logs and errors never contain either API key, the prompt or customer text', async () => {
    const h = makeHarness({
      gemini: { 'gemini-3.5-flash-lite': [{ kind: 'status', status: 503 }] },
      openai: { 'gpt-6-luna': [{ kind: 'status', status: 429 }] },
    });
    const ok = await h.build(OWNER_CHAIN).complete(SYS, MSGS, []);
    expect(textOf(ok)).toBe('from gemini:gemini-3.5-flash');
    const h2 = makeHarness({ openai: { 'gpt-6-luna': [{ kind: 'status', status: 401 }] } });
    const failed = await h2.build([openai('gpt-6-luna')]).complete(SYS, MSGS, []);
    const surfaced = JSON.stringify([h.warn.mock.calls, h2.warn.mock.calls, failed]);
    for (const secret of [GEMINI_KEY, OPENAI_KEY, SYS, CUSTOMER_TEXT]) {
      expect(surfaced).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// Tool-use affinity and cross-provider history
// ---------------------------------------------------------------------------

describe('createModelChainLlm — tool-use affinity across providers', () => {
  it('after an OpenAI tool call, the follow-up tries openai:gpt-6-luna first and replays matching ids', async () => {
    const h = makeHarness({
      gemini: { 'gemini-3.5-flash-lite': [{ kind: 'status', status: 503 }] },
      openai: { 'gpt-6-luna': [{ kind: 'toolCall', id: 'call_luna_1' }] },
    });
    const chain = h.build(OWNER_CHAIN);

    const first = await chain.complete(SYS, MSGS, []);
    if (!first.ok) throw new Error('expected ok');
    expect(first.value.toolUses).toEqual([
      { id: 'call_luna_1', name: 'getBusinessInfo', input: {}, producerModel: 'openai:gpt-6-luna' },
    ]);

    const history: LlmMessage[] = [
      ...MSGS,
      { role: 'assistant-tool-use', toolUses: first.value.toolUses },
      {
        role: 'tool',
        toolUseId: 'call_luna_1',
        toolName: 'getBusinessInfo',
        content: '{"ok":true}',
      },
    ];
    const second = await chain.complete(SYS, history, []);
    expect(textOf(second)).toBe('from openai:gpt-6-luna');
    // Turn 1: lite 503 → luna. Turn 2: luna first (affinity), lite not retried.
    expect(h.calls).toEqual([
      'gemini:gemini-3.5-flash-lite',
      'openai:gpt-6-luna',
      'openai:gpt-6-luna',
    ]);
    const replayed = h.openaiBodies[1]?.messages as Array<Record<string, unknown>>;
    expect(replayed.slice(-2)).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_luna_1',
            type: 'function',
            function: { name: 'getBusinessInfo', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_luna_1', content: '{"ok":true}' },
    ]);
  });

  it('a Gemini tool call is stamped gemini:<model>; when it fails on the follow-up, OpenAI gets valid synthesized ids and no signature', async () => {
    const h = makeHarness({
      gemini: {
        'gemini-3.5-flash-lite': [
          { kind: 'toolCall', id: '', signature: 'R0VNSU5JLVNJRw==' },
          { kind: 'status', status: 503 },
        ],
      },
    });
    const chain = h.build(OWNER_CHAIN);

    const first = await chain.complete(SYS, MSGS, []);
    if (!first.ok) throw new Error('expected ok');
    expect(first.value.toolUses).toEqual([
      {
        id: '',
        name: 'getBusinessInfo',
        input: {},
        thoughtSignature: 'R0VNSU5JLVNJRw==',
        producerModel: 'gemini:gemini-3.5-flash-lite',
      },
    ]);

    const history: LlmMessage[] = [
      ...MSGS,
      { role: 'assistant-tool-use', toolUses: first.value.toolUses },
      { role: 'tool', toolUseId: '', toolName: 'getBusinessInfo', content: '{"ok":true}' },
    ];
    const second = await chain.complete(SYS, history, []);
    expect(textOf(second)).toBe('from openai:gpt-6-luna');
    expect(h.calls).toEqual([
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.5-flash-lite',
      'openai:gpt-6-luna',
    ]);
    // The Gemini replay still carried its own signature (T3 behavior preserved).
    const geminiReplay = (h.geminiRequests[1]?.contents as Content[])
      .flatMap((c) => c.parts ?? [])
      .find((part) => part.functionCall !== undefined);
    expect(geminiReplay?.thoughtSignature).toBe('R0VNSU5JLVNJRw==');
    expect(JSON.stringify(h.geminiRequests[1]?.contents)).not.toContain('producerModel');

    const replayed = h.openaiBodies[0]?.messages as Array<{
      role: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string }>;
    }>;
    const assistant = replayed.find((m) => m.role === 'assistant');
    const tool = replayed.find((m) => m.role === 'tool');
    expect(assistant?.tool_calls?.[0]?.id).toMatch(/\S+/);
    expect(tool?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id);
    expect(JSON.stringify(replayed)).not.toContain('R0VNSU5JLVNJRw==');
  });

  it('ignores a producer model that is not in the configured chain', async () => {
    const h = makeHarness();
    const history: LlmMessage[] = [
      ...MSGS,
      {
        role: 'assistant-tool-use',
        toolUses: [
          { id: 'c1', name: 'getBusinessInfo', input: {}, producerModel: 'openai:gpt-retired' },
        ],
      },
      { role: 'tool', toolUseId: 'c1', toolName: 'getBusinessInfo', content: '{}' },
    ];
    await h.build(OWNER_CHAIN).complete(SYS, history, []);
    expect(h.calls).toEqual(['gemini:gemini-3.5-flash-lite']);
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('createModelChainLlm — wiring', () => {
  it('passes the per-attempt timeout to every provider factory (default 20000 ms)', () => {
    const h = makeHarness();
    h.build(OWNER_CHAIN);
    h.build([openai('gpt-6-luna')], 15_000);
    expect(h.factoryTimeouts).toEqual([
      { provider: 'gemini', model: 'gemini-3.5-flash-lite', timeoutMs: 20_000 },
      { provider: 'openai', model: 'gpt-6-luna', timeoutMs: 20_000 },
      { provider: 'gemini', model: 'gemini-3.5-flash', timeoutMs: 20_000 },
      { provider: 'openai', model: 'gpt-6-luna', timeoutMs: 15_000 },
    ]);
  });

  it('drops duplicate entries (first occurrence wins)', async () => {
    const h = makeHarness({ gemini: { m: [{ kind: 'status', status: 503 }] } });
    await h.build([gemini('m'), openai('o'), gemini('m')]).complete(SYS, MSGS, []);
    expect(h.calls).toEqual(['gemini:m', 'openai:o']);
  });

  it('fails fast at construction when no model is configured', () => {
    expect(() => createModelChainLlm([], { providers: {} })).toThrow(/at least one model/);
  });

  it('fails fast at construction when a provider has no factory', () => {
    const answering: LlmAdapter = { complete: async () => err({ code: 'LLM_BAD_RESPONSE' }) };
    expect(() =>
      createModelChainLlm([gemini('m'), openai('gpt-6-luna')], {
        providers: { gemini: () => answering },
      }),
    ).toThrow(/openai/);
  });
});
