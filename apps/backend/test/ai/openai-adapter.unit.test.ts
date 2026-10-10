/**
 * openai-adapter.unit.test.ts — createOpenAiAdapter against a stubbed fetch
 * (injected through options — no global patching, no real OpenAI call).
 *
 * Exercises:
 * - Chat Completions request shape: model, developer (system) message first,
 *   reasoning_effort "none", max_completion_tokens, function tools.
 * - History mapping: text turns, assistant tool_calls, tool results with matching
 *   tool_call_id, deterministic ids synthesized for empty ToolUseBlock ids.
 * - Response mapping: text, tool_calls → ToolUseBlock (producerModel
 *   openai:<model>), finish_reason → stopReason, malformed arguments → typed error.
 * - Failures as Result (never thrown): HTTP status + OpenAI error.code/type,
 *   per-attempt timeout, network error, unusable body. The key never leaks.
 */

import { describe, expect, it } from 'vitest';
import type { LlmAdapter } from '../../src/ai/llm-adapter.js';
import type { LlmMessage, LlmTool } from '../../src/ai/llm-types.js';
import { OPENAI_CHAT_COMPLETIONS_URL, createOpenAiAdapter } from '../../src/ai/openai-adapter.js';
import type { OpenAiFetch } from '../../src/ai/openai-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY = 'sk-SECRET-SENTINEL-KEY-0001';
const MODEL = 'gpt-6-luna';
const SYS = 'SYSTEM_PROMPT_SENTINEL';
const MSGS: LlmMessage[] = [{ role: 'user', content: 'Hola' }];

const TOOL: LlmTool = {
  name: 'getBusinessInfo',
  description: 'Returns business info',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

type FetchOutcome =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'raw'; readonly status: number; readonly text: string }
  | { readonly kind: 'hang' }
  | { readonly kind: 'network' };

type CapturedRequest = {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
};

/** A chat.completion body with one choice. */
const completion = (message: Record<string, unknown>, finishReason = 'stop') => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
});

const textReply = (text: string): FetchOutcome => ({
  kind: 'json',
  status: 200,
  body: completion({ content: text }),
});

/** Fetch stub: dequeues scripted outcomes; unscripted calls answer "ok". */
function makeFetchStub(outcomes: FetchOutcome[] = []) {
  const queue = [...outcomes];
  const requests: CapturedRequest[] = [];
  const fetchFn: OpenAiFetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const outcome = queue.shift() ?? textReply('ok');
    switch (outcome.kind) {
      case 'json':
        return new Response(JSON.stringify(outcome.body), {
          status: outcome.status,
          headers: { 'content-type': 'application/json' },
        });
      case 'raw':
        return new Response(outcome.text, { status: outcome.status });
      case 'network':
        throw new TypeError('fetch failed');
      case 'hang':
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
    }
  };
  return { fetchFn, requests };
}

const adapterWith = (outcomes: FetchOutcome[] = [], timeoutMs?: number) => {
  const stub = makeFetchStub(outcomes);
  const adapter = createOpenAiAdapter(KEY, MODEL, {
    fetchFn: stub.fetchFn,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { adapter, ...stub };
};

type BodyMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
};

const bodyMessages = (request: CapturedRequest | undefined): BodyMessage[] =>
  (request?.body.messages ?? []) as BodyMessage[];

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter — request shape', () => {
  it('POSTs to Chat Completions with Bearer auth, reasoning_effort none and the developer prompt first', async () => {
    const { adapter, requests } = adapterWith();
    const result = await adapter.complete(SYS, MSGS, [TOOL]);
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(request?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(request?.init.method).toBe('POST');
    const headers = new Headers(request?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
    expect(request?.body).toEqual({
      model: MODEL,
      messages: [
        { role: 'developer', content: SYS },
        { role: 'user', content: 'Hola' },
      ],
      reasoning_effort: 'none',
      max_completion_tokens: 1024,
      tools: [
        {
          type: 'function',
          function: {
            name: 'getBusinessInfo',
            description: 'Returns business info',
            parameters: TOOL.inputSchema,
          },
        },
      ],
    });
  });

  it('omits tools when the allowlist is empty', async () => {
    const { adapter, requests } = adapterWith();
    await adapter.complete(SYS, MSGS, []);
    expect(requests[0]?.body).not.toHaveProperty('tools');
  });

  it('the API key travels only in the Authorization header, never in the body', async () => {
    const { adapter, requests } = adapterWith();
    await adapter.complete(SYS, MSGS, [TOOL]);
    expect(String(requests[0]?.init.body)).not.toContain(KEY);
  });

  it('maps text turns, assistant tool_calls and tool results with matching ids', async () => {
    const { adapter, requests } = adapterWith();
    const history: LlmMessage[] = [
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' },
      { role: 'user', content: '¿Horario?' },
      {
        role: 'assistant-tool-use',
        toolUses: [
          {
            id: 'call_abc',
            name: 'getBusinessInfo',
            input: { topic: 'hours' },
            thoughtSignature: 'R0VNSU5JLVNJRw==',
            producerModel: 'gemini:gemini-3.5-flash',
          },
        ],
      },
      {
        role: 'tool',
        toolUseId: 'call_abc',
        toolName: 'getBusinessInfo',
        content: '{"hours":"9-18"}',
      },
    ];
    await adapter.complete(SYS, history, [TOOL]);
    expect(bodyMessages(requests[0])).toEqual([
      { role: 'developer', content: SYS },
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' },
      { role: 'user', content: '¿Horario?' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'getBusinessInfo', arguments: '{"topic":"hours"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"hours":"9-18"}' },
    ]);
    // Gemini-only metadata never reaches OpenAI.
    const raw = String(requests[0]?.init.body);
    expect(raw).not.toContain('R0VNSU5JLVNJRw==');
    expect(raw).not.toContain('thoughtSignature');
    expect(raw).not.toContain('producerModel');
  });

  it('synthesizes deterministic, distinct ids for empty tool-use ids and reuses them on the results', async () => {
    const { adapter, requests } = adapterWith();
    const history: LlmMessage[] = [
      ...MSGS,
      {
        role: 'assistant-tool-use',
        toolUses: [
          { id: '', name: 'getBusinessInfo', input: {} },
          { id: '', name: 'classifyContact', input: { intent: 'compra' } },
        ],
      },
      { role: 'tool', toolUseId: '', toolName: 'getBusinessInfo', content: '{"ok":true}' },
      { role: 'tool', toolUseId: '', toolName: 'classifyContact', content: '{"ok":true}' },
    ];
    await adapter.complete(SYS, history, [TOOL]);
    await adapter.complete(SYS, history, [TOOL]);

    const messages = bodyMessages(requests[0]);
    const calls = messages[2]?.tool_calls ?? [];
    const [first, second] = calls;
    expect(calls).toHaveLength(2);
    expect(first?.id).toMatch(/\S+/);
    expect(second?.id).toMatch(/\S+/);
    expect(first?.id).not.toBe(second?.id);
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: first?.id, content: '{"ok":true}' });
    expect(messages[4]).toEqual({ role: 'tool', tool_call_id: second?.id, content: '{"ok":true}' });
    // Deterministic: the same history yields the same ids on the next attempt.
    expect(bodyMessages(requests[1])).toEqual(messages);
  });

  it('matches synthesized ids by tool name when results arrive in a different order', async () => {
    const { adapter, requests } = adapterWith();
    const history: LlmMessage[] = [
      ...MSGS,
      {
        role: 'assistant-tool-use',
        toolUses: [
          { id: '', name: 'getBusinessInfo', input: {} },
          { id: '', name: 'classifyContact', input: {} },
        ],
      },
      { role: 'tool', toolUseId: '', toolName: 'classifyContact', content: '"c"' },
      { role: 'tool', toolUseId: '', toolName: 'getBusinessInfo', content: '"b"' },
    ];
    await adapter.complete(SYS, history, [TOOL]);
    const messages = bodyMessages(requests[0]);
    const ids = new Map((messages[2]?.tool_calls ?? []).map((c) => [c.function.name, c.id]));
    expect(messages[3]?.tool_call_id).toBe(ids.get('classifyContact'));
    expect(messages[4]?.tool_call_id).toBe(ids.get('getBusinessInfo'));
  });
});

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter — response mapping', () => {
  it('text reply → ok({ text, toolUses: [], stopReason: "end_turn" })', async () => {
    const { adapter } = adapterWith([textReply('¡Hola! Atendemos de 9 a 18.')]);
    const result = await adapter.complete(SYS, MSGS, []);
    expect(result).toEqual({
      ok: true,
      value: { text: '¡Hola! Atendemos de 9 a 18.', toolUses: [], stopReason: 'end_turn' },
    });
  });

  it('tool_calls → ToolUseBlocks with parsed input and producerModel openai:<model>', async () => {
    const { adapter } = adapterWith([
      {
        kind: 'json',
        status: 200,
        body: completion(
          {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'getBusinessInfo', arguments: '{}' },
              },
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'classifyContact', arguments: '{"intent":"compra","tags":[]}' },
              },
            ],
          },
          'tool_calls',
        ),
      },
    ]);
    const result = await adapter.complete(SYS, MSGS, [TOOL]);
    expect(result).toEqual({
      ok: true,
      value: {
        text: null,
        toolUses: [
          { id: 'call_1', name: 'getBusinessInfo', input: {}, producerModel: 'openai:gpt-6-luna' },
          {
            id: 'call_2',
            name: 'classifyContact',
            input: { intent: 'compra', tags: [] },
            producerModel: 'openai:gpt-6-luna',
          },
        ],
        stopReason: 'tool_use',
      },
    });
  });

  it('empty arguments string is read as an empty input object', async () => {
    const { adapter } = adapterWith([
      {
        kind: 'json',
        status: 200,
        body: completion(
          {
            content: null,
            tool_calls: [
              { id: 'c', type: 'function', function: { name: 'getBusinessInfo', arguments: '' } },
            ],
          },
          'tool_calls',
        ),
      },
    ]);
    const result = await adapter.complete(SYS, MSGS, [TOOL]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.toolUses[0]?.input).toEqual({});
  });

  it.each([
    ['length', 'max_tokens'],
    ['content_filter', 'other'],
    ['stop', 'end_turn'],
  ])('finish_reason %s → stopReason %s', async (finishReason, stopReason) => {
    const { adapter } = adapterWith([
      { kind: 'json', status: 200, body: completion({ content: 'x' }, finishReason) },
    ]);
    const result = await adapter.complete(SYS, MSGS, []);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.stopReason).toBe(stopReason);
  });

  it('malformed tool-call arguments → err LLM_BAD_RESPONSE (never throws, no raw arguments)', async () => {
    const { adapter } = adapterWith([
      {
        kind: 'json',
        status: 200,
        body: completion(
          {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'classifyContact', arguments: '{"intent": "compra", DNI 4455' },
              },
            ],
          },
          'tool_calls',
        ),
      },
    ]);
    const result = await adapter.complete(SYS, MSGS, [TOOL]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('never');
    expect(result.error.code).toBe('LLM_BAD_RESPONSE');
    expect(JSON.stringify(result.error)).not.toContain('DNI 4455');
  });

  it.each([
    ['a non-JSON body', { kind: 'raw', status: 200, text: '<html>oops</html>' } as const],
    ['a body without choices', { kind: 'json', status: 200, body: { choices: [] } } as const],
  ])('%s → err LLM_BAD_RESPONSE', async (_label, outcome) => {
    const { adapter } = adapterWith([outcome]);
    const result = await adapter.complete(SYS, MSGS, []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('never');
    expect(result.error.code).toBe('LLM_BAD_RESPONSE');
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter — failures (Result, never thrown)', () => {
  it.each([
    [401, 'invalid_request_error', 'invalid_api_key'],
    [429, 'insufficient_quota', 'insufficient_quota'],
    [503, 'service_unavailable_error', 'server_is_overloaded'],
  ])(
    'HTTP %i → LLM_API_ERROR with status, error.type and error.code (message dropped)',
    async (status, type, code) => {
      const { adapter } = adapterWith([
        {
          kind: 'json',
          status,
          body: {
            error: {
              message: `Incorrect API key provided: ${KEY.slice(0, 8)}****0001. Customer said hola`,
              type,
              param: null,
              code,
            },
          },
        },
      ]);
      const result = await adapter.complete(SYS, MSGS, []);
      expect(result).toEqual({
        ok: false,
        error: { code: 'LLM_API_ERROR', status, errorType: type, errorCode: code },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(KEY.slice(0, 8));
      expect(serialized).not.toContain('Incorrect API key');
    },
  );

  it('HTTP error with a non-JSON body still carries the status', async () => {
    const { adapter } = adapterWith([{ kind: 'raw', status: 502, text: 'Bad Gateway' }]);
    const result = await adapter.complete(SYS, MSGS, []);
    expect(result).toEqual({ ok: false, error: { code: 'LLM_API_ERROR', status: 502 } });
  });

  it('a hanging request is aborted at timeoutMs → err LLM_TIMEOUT', async () => {
    const { adapter, requests } = adapterWith([{ kind: 'hang' }], 20);
    const result = await adapter.complete(SYS, MSGS, []);
    expect(result).toEqual({ ok: false, error: { code: 'LLM_TIMEOUT', timeoutMs: 20 } });
    expect(requests[0]?.init.signal?.aborted).toBe(true);
  }, 2_000);

  it('a network failure (fetch rejects) → err LLM_NETWORK_ERROR', async () => {
    const { adapter } = adapterWith([{ kind: 'network' }]);
    const result = await adapter.complete(SYS, MSGS, []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('never');
    expect(result.error.code).toBe('LLM_NETWORK_ERROR');
  });

  it('no failure result ever contains the API key, the prompt or customer text', async () => {
    const customerText = 'Mi DNI es 44556677';
    const { adapter } = adapterWith([
      { kind: 'json', status: 401, body: { error: { message: KEY, type: 'x', code: 'y' } } },
      { kind: 'network' },
      { kind: 'raw', status: 200, text: 'not json' },
    ]);
    const history: LlmMessage[] = [{ role: 'user', content: customerText }];
    const results = [
      await adapter.complete(SYS, history, []),
      await adapter.complete(SYS, history, []),
      await adapter.complete(SYS, history, []),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(KEY);
      expect(serialized).not.toContain(SYS);
      expect(serialized).not.toContain(customerText);
    }
  });

  it('satisfies the LlmAdapter contract', () => {
    const adapter: LlmAdapter = createOpenAiAdapter(KEY, MODEL, {
      fetchFn: makeFetchStub().fetchFn,
    });
    expect(typeof adapter.complete).toBe('function');
  });

  it.each([
    ['an empty API key', '', MODEL],
    ['an empty model', KEY, '  '],
  ])(
    'fails fast at construction with %s (message never contains the key)',
    (_label, key, model) => {
      let message = '';
      try {
        createOpenAiAdapter(key, model, { fetchFn: makeFetchStub().fetchFn });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/openai-adapter/);
      expect(message).not.toContain(KEY);
    },
  );
});
