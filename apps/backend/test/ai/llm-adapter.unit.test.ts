/**
 * llm-adapter.unit.test.ts — Unit tests for createFakeLlmAdapter (and compilation of createAnthropicAdapter).
 *
 * Exercises the fake adapter contract:
 * - Default response is ok({ text: 'fake reply', toolUses: [], stopReason: 'end_turn' }).
 * - queueResponse() pre-loads a response that is consumed on the next call.
 * - After the queue is exhausted, calls wrap around to the default.
 * - calls[] records every call in order.
 * - createAnthropicAdapter compiles (TypeScript-level check only — no real API call).
 *
 * STRICT TDD MODE — written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import type { LlmAdapter } from '../../src/ai/llm-adapter.js';
import { createAnthropicAdapter, createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';

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
