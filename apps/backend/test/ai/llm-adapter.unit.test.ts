/**
 * llm-adapter.unit.test.ts — Unit tests for createFakeLlmAdapter, createAnthropicAdapter
 * (type-check only), and createGeminiAdapter (stub-injected, no real API call).
 *
 * Exercises:
 * - createFakeLlmAdapter: default response, queueResponse, calls[], script array.
 * - createAnthropicAdapter: TypeScript compilation only (no real Anthropic call).
 * - createGeminiAdapter: text response mapping, functionCall mapping, error handling,
 *   apiKey not leaked into generate params, LlmAdapter type-check.
 *
 * STRICT TDD MODE — Gemini adapter tests written RED before implementation.
 */

import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter } from '../../src/ai/llm-adapter.js';
import {
  createAnthropicAdapter,
  createFakeLlmAdapter,
  createGeminiAdapter,
} from '../../src/ai/llm-adapter.js';

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
});
