/**
 * llm-adapter.ts — Injectable LLM egress (functional DI, NO class).
 *
 * Mirrors the MetaClient pattern established for WhatsApp egress (ADR-0017).
 *
 * Exports:
 * - LlmAdapter: injectable contract (interface)
 * - createAnthropicAdapter(apiKey, model): Anthropic SDK implementation (retained, not default)
 * - createGeminiAdapter(apiKey, model | models, _testGenerateFn?, options?): Gemini SDK
 *   implementation (ACTIVE default) with an ordered model fallback chain and a
 *   per-attempt timeout
 * - FALLBACK_HTTP_STATUSES / orderForHistory: the fallback classification and the
 *   tool-use model affinity, shared with the cross-provider chain (model-chain.ts)
 * - createFakeLlmAdapter(script?): test double with calls[] and queueResponse()
 *
 * Security invariants:
 * - apiKey is NEVER logged anywhere in this module
 * - customer text is always in the 'user' role (system is a separate parameter, D8)
 * - provider-specific types (Anthropic SDK, Gemini SDK) never leak into calling code
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type {
  Content,
  GenerateContentParameters,
  GenerateContentResponse,
  Tool,
} from '@google/genai';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type { LlmError, LlmMessage, LlmResponse, LlmTool, ToolUseBlock } from './llm-types.js';
import { buildLlmUsage } from './llm-usage.js';

// ---------------------------------------------------------------------------
// Injectable contract
// ---------------------------------------------------------------------------

/** The injectable contract. Production = createAnthropicAdapter; tests = createFakeLlmAdapter. */
export type LlmAdapter = {
  /**
   * Single completion call. The system prompt is passed separately (D8) to keep
   * the customer 'user' turns isolated from the agent's immutable instructions.
   *
   * @param system   - The per-vertical system prompt (immutable for this vertical).
   * @param messages - Conversation history + the current customer turn.
   * @param tools    - Allowed tool schemas (the allowlist, not function refs).
   */
  complete(
    system: string,
    messages: readonly LlmMessage[],
    tools: readonly LlmTool[],
  ): Promise<Result<LlmResponse, LlmError>>;
};

// ---------------------------------------------------------------------------
// Helpers — Anthropic SDK → provider-neutral mapping
// ---------------------------------------------------------------------------

function mapAnthropicStopReason(reason: string | null | undefined): LlmResponse['stopReason'] {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'other';
  }
}

/** Maps Anthropic content blocks → provider-neutral LlmResponse. */
function mapAnthropicResponse(response: Anthropic.Message): LlmResponse {
  let text: string | null = null;
  const toolUses: ToolUseBlock[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      text = block.text;
    } else if (block.type === 'tool_use') {
      toolUses.push({
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }

  return {
    text,
    toolUses,
    stopReason: mapAnthropicStopReason(response.stop_reason),
  };
}

/** Maps LlmMessage[] → Anthropic MessageParam[]. */
function mapMessages(messages: readonly LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg): Anthropic.MessageParam => {
    if (msg.role === 'user') {
      return { role: 'user', content: msg.content };
    }
    if (msg.role === 'assistant') {
      return { role: 'assistant', content: msg.content };
    }
    if (msg.role === 'assistant-tool-use') {
      // Anthropic: assistant turn with tool_use content blocks
      return {
        role: 'assistant',
        content: msg.toolUses.map((tu) => ({
          type: 'tool_use' as const,
          id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
        })),
      };
    }
    // tool result: fed back as a 'user' message with tool_result content block.
    // Anthropic only needs tool_use_id — toolName is ignored here.
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolUseId,
          content: msg.content,
        },
      ],
    };
  });
}

/** Maps LlmTool[] → Anthropic Tool[]. */
function mapTools(tools: readonly LlmTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));
}

// ---------------------------------------------------------------------------
// Real implementation — @anthropic-ai/sdk
// ---------------------------------------------------------------------------

/**
 * Real Anthropic implementation. apiKey is NEVER logged.
 * Catches all SDK throws and maps them to LlmError (never throws to caller).
 */
export const createAnthropicAdapter = (apiKey: string, model: string): LlmAdapter => {
  const client = new Anthropic({ apiKey });

  return {
    async complete(system, messages, tools) {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          system,
          messages: mapMessages(messages),
          ...(tools.length > 0 ? { tools: mapTools(tools) } : {}),
        });
        return ok(mapAnthropicResponse(response));
      } catch (cause) {
        if (cause instanceof Anthropic.APIError) {
          return err({
            code: 'LLM_API_ERROR' as const,
            status: cause.status,
            detail: cause.message,
          });
        }
        return err({ code: 'LLM_NETWORK_ERROR' as const, cause });
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Real implementation — @google/genai (ACTIVE default)
// ---------------------------------------------------------------------------

/**
 * Maps our neutral LlmMessage[] to Gemini Content[].
 *
 * Roles:
 * - 'user'               → Gemini 'user' role with text part
 * - 'assistant'          → Gemini 'model' role with text part
 * - 'assistant-tool-use' → Gemini 'model' role with functionCall parts
 * - 'tool'               → Gemini 'user' role with functionResponse part.
 *   Uses msg.toolName (the real function name) as functionResponse.name —
 *   Gemini requires the function name for correct tool round-trips.
 */
function mapGeminiMessages(messages: readonly LlmMessage[]): Content[] {
  return messages.map((msg): Content => {
    if (msg.role === 'user') {
      return { role: 'user', parts: [{ text: msg.content }] };
    }
    if (msg.role === 'assistant') {
      return { role: 'model', parts: [{ text: msg.content }] };
    }
    if (msg.role === 'assistant-tool-use') {
      // Gemini: model turn with functionCall parts. Each part re-emits the
      // thoughtSignature its block carried (Part-level field, sibling of
      // functionCall) — Gemini 3 rejects the request otherwise. Blocks without a
      // signature produce parts without the field (parallel calls: only the
      // first part has one).
      return {
        role: 'model',
        parts: msg.toolUses.map((tu) => ({
          functionCall: {
            id: tu.id,
            name: tu.name,
            args: tu.input as Record<string, unknown>,
          },
          ...(tu.thoughtSignature !== undefined ? { thoughtSignature: tu.thoughtSignature } : {}),
        })),
      } as Content;
    }
    // tool role: function response fed back as a user turn.
    // msg.toolName carries the REAL function name — required by Gemini.
    let responsePayload: Record<string, unknown>;
    try {
      responsePayload = JSON.parse(msg.content) as Record<string, unknown>;
    } catch {
      responsePayload = { result: msg.content };
    }
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: msg.toolUseId,
            name: msg.toolName, // real function name — previously used toolUseId as placeholder
            response: responsePayload,
          },
        },
      ],
    } as Content;
  });
}

/** Maps our neutral LlmTool[] to Gemini Tool[] (via functionDeclarations). */
function mapGeminiTools(tools: readonly LlmTool[]): Tool[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // parametersJsonSchema accepts our JSON Schema object directly
        parametersJsonSchema: t.inputSchema,
      })),
    },
  ];
}

/**
 * Maps a Gemini GenerateContentResponse to our neutral LlmResponse.
 * `model` is the model that answered; it is stamped on every ToolUseBlock as
 * `producerModel` so a replayed tool-use turn can prefer the same model.
 */
function mapGeminiResponse(response: GenerateContentResponse, model: string): LlmResponse {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  let text: string | null = null;
  const toolUses: ToolUseBlock[] = [];

  for (const part of parts) {
    if (typeof part.text === 'string') {
      text = (text ?? '') + part.text;
    }
    if (part.functionCall) {
      toolUses.push({
        id: part.functionCall.id ?? '',
        name: part.functionCall.name ?? '',
        input: part.functionCall.args ?? {},
        // Opaque Gemini 3 signature — carried so mapGeminiMessages can echo it back.
        ...(typeof part.thoughtSignature === 'string'
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
        producerModel: model,
      });
    }
  }

  // Determine stop reason: tool_use takes priority, then MAX_TOKENS, else end_turn.
  const finishReason = candidate?.finishReason as string | undefined;
  let stopReason: LlmResponse['stopReason'];
  if (toolUses.length > 0) {
    stopReason = 'tool_use';
  } else if (finishReason === 'MAX_TOKENS') {
    stopReason = 'max_tokens';
  } else {
    stopReason = 'end_turn';
  }

  const usage = mapGeminiUsage(response.usageMetadata);
  return {
    text,
    toolUses,
    stopReason,
    ...(usage !== undefined ? { usage } : {}),
    answeredBy: { provider: 'gemini', model },
  };
}

/**
 * Maps Gemini `usageMetadata` (GenerateContentResponseUsageMetadata,
 * @google/genai 2.10.0 dist/genai.d.ts:5001-5024) onto the neutral LlmUsage.
 * Per the SDK docs, totalTokenCount = promptTokenCount + candidatesTokenCount +
 * toolUsePromptTokenCount + thoughtsTokenCount, so:
 * - input  = promptTokenCount (cachedContentTokenCount included) + toolUsePromptTokenCount
 * - output = candidatesTokenCount + thoughtsTokenCount (thinking is billed as output)
 * Absent metadata → undefined; never throws.
 */
function mapGeminiUsage(metadata: GenerateContentResponse['usageMetadata']): LlmResponse['usage'] {
  if (metadata === undefined || metadata === null) return undefined;
  return buildLlmUsage({
    input: [metadata.promptTokenCount, metadata.toolUsePromptTokenCount],
    output: [metadata.candidatesTokenCount, metadata.thoughtsTokenCount],
    reasoning: metadata.thoughtsTokenCount,
    cachedInput: metadata.cachedContentTokenCount,
    total: metadata.totalTokenCount,
  });
}

/**
 * Internal type for the stub-injectable generate function (test seam).
 * Matches the signature of `client.models.generateContent`.
 */
export type GeminiGenerateFn = (
  params: GenerateContentParameters,
) => Promise<GenerateContentResponse>;

// ---------------------------------------------------------------------------
// Gemini model fallback chain
// ---------------------------------------------------------------------------

/** Per-attempt timeout used when the caller does not inject one. */
export const DEFAULT_GEMINI_ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * HTTP statuses that move on to the next model: model gone for this key (404),
 * request timeout (408), throttled (429) or temporarily failing (500/502/503/504).
 * Anything else — notably 400/401/403 (bad request, invalid or unauthorized key) —
 * is deterministic: every model would fail the same way, so it returns at once.
 */
export const FALLBACK_HTTP_STATUSES: ReadonlySet<number> = new Set([
  404, 408, 429, 500, 502, 503, 504,
]);

/** Why one model attempt failed. */
export type GeminiAttemptFailureReason = 'http_error' | 'timeout' | 'network_error';

/** One failed attempt of the chain. Safe to log: no key, prompt or customer text. */
export type GeminiAttemptSummary = {
  readonly model: string;
  readonly reason: GeminiAttemptFailureReason;
  /** HTTP status of the SDK ApiError; null for timeouts and network errors. */
  readonly status: number | null;
};

/** `cause` of the LLM_NETWORK_ERROR returned when the chain ends without an answer. */
export type GeminiChainFailure = {
  /** Raw error of the last attempt (SDK ApiError, network error or timeout marker). */
  readonly lastError: unknown;
  /** Every attempt in the order it ran, with its HTTP status or failure reason. */
  readonly attempts: readonly GeminiAttemptSummary[];
};

/** Payload of the `llm_model_fallback` warning. */
export type LlmModelFallbackEvent = {
  readonly fromModel: string;
  readonly toModel: string;
  readonly status: number | null;
  readonly reason: GeminiAttemptFailureReason;
};

/** Minimal logger dependency — a pino Logger satisfies it. */
export type LlmAdapterLogger = {
  warn(event: LlmModelFallbackEvent, msg: string): void;
};

export type GeminiAdapterOptions = {
  /** Per-attempt timeout in ms; a timed-out attempt falls back. Default 20 000. */
  readonly timeoutMs?: number;
  /** Receives one warn (`llm_model_fallback`) per fallback. */
  readonly logger?: LlmAdapterLogger;
};

type AttemptOutcome =
  | { readonly ok: true; readonly response: GenerateContentResponse }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly summary: GeminiAttemptSummary;
      readonly error: unknown;
    };

const TIMED_OUT = Symbol('gemini-attempt-timed-out');

/** Numeric HTTP status of an SDK ApiError (duck-typed); undefined for anything else. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const { status } = error as { status: unknown };
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

/**
 * Runs one generate call bounded by `timeoutMs`. On timeout the request is
 * cancelled through `GenerateContentConfig.abortSignal` (the @google/genai
 * per-request cancel hook) and the race resolves, so the attempt stays bounded
 * even if the transport ignores the signal. Never throws.
 */
async function attemptGenerate(
  generateFn: GeminiGenerateFn,
  params: GenerateContentParameters,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  const { model } = params;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref();
  });

  try {
    const response = await Promise.race([
      generateFn({ ...params, config: { ...params.config, abortSignal: controller.signal } }),
      timedOut,
    ]);
    if (response !== TIMED_OUT) return { ok: true, response };
    controller.abort();
    return {
      ok: false,
      retryable: true,
      summary: { model, reason: 'timeout', status: null },
      error: { code: 'GEMINI_ATTEMPT_TIMEOUT', model, timeoutMs },
    };
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === undefined) {
      // No HTTP status: the request never got an answer (DNS, reset, fetch failed).
      return {
        ok: false,
        retryable: true,
        summary: { model, reason: 'network_error', status: null },
        error,
      };
    }
    return {
      ok: false,
      retryable: FALLBACK_HTTP_STATUSES.has(status),
      summary: { model, reason: 'http_error', status },
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes one model or an ordered list: splits on commas, trims, drops empty
 * entries and duplicates (first occurrence wins).
 */
function normalizeModels(model: string | readonly string[]): string[] {
  const entries = (typeof model === 'string' ? [model] : model).flatMap((m) => m.split(','));
  return [...new Set(entries.map((m) => m.trim()).filter((m) => m.length > 0))];
}

/**
 * Model affinity for tool use: when the latest assistant-tool-use turn was
 * produced by a model of the chain, that model goes first, then the rest in
 * configured order.
 *
 * Cross-model signatures: Gemini docs (Thinking guide → "Thought signatures" →
 * "Stateless mode", https://ai.google.dev/gemini-api/docs/thinking#signatures)
 * state that when switching models within a session you should still resend the
 * previous model's thought blocks and that the backend manages compatibility.
 * So falling back to another model replays the signatures unchanged (never
 * stripped, never replaced by dummy values); affinity keeps reasoning continuity
 * and avoids relying on that cross-model path while the producer is healthy.
 */
export function orderForHistory(
  models: readonly string[],
  messages: readonly LlmMessage[],
): readonly string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant-tool-use') continue;
    const producer = msg.toolUses.find((tu) => tu.producerModel !== undefined)?.producerModel;
    if (producer === undefined || !models.includes(producer)) return models;
    return [producer, ...models.filter((m) => m !== producer)];
  }
  return models;
}

/**
 * Real Gemini implementation with an ordered model fallback chain.
 * apiKey is NEVER logged. Catches all SDK throws and maps them to LlmError
 * (never throws to caller from complete()).
 *
 * Each complete() tries the models in order (tool-use follow-ups start with the
 * model that produced the tool call). Retryable failures — 404/408/429/5xx, the
 * per-attempt timeout, network errors without status — move to the next model
 * and emit `llm_model_fallback`; deterministic ones (400/401/403) return at once.
 * When the chain ends without an answer: err LLM_NETWORK_ERROR whose cause is a
 * GeminiChainFailure (last error + attempts with real HTTP statuses).
 *
 * @param apiKey          - Google AI API key. Bound to the SDK client, not logged.
 * @param model           - One Gemini model ID or an ordered list (fallback chain).
 * @param _testGenerateFn - Optional test seam: inject a stubbed generate function
 *                          instead of creating a real GoogleGenAI client.
 *                          ONLY for unit tests — never set in production.
 * @param options         - Per-attempt timeout and fallback logger.
 * @throws at construction (wiring time) when no model is configured.
 */
export const createGeminiAdapter = (
  apiKey: string,
  model: string | readonly string[],
  _testGenerateFn?: GeminiGenerateFn,
  options: GeminiAdapterOptions = {},
): LlmAdapter => {
  const models = normalizeModels(model);
  if (models.length === 0) {
    // Infrastructure misconfiguration: fail fast at startup, not per request.
    throw new Error('[llm-adapter] createGeminiAdapter requires at least one model');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_ATTEMPT_TIMEOUT_MS;
  const { logger } = options;

  // apiKey binds to the SDK client here and is NEVER referenced after this point.
  let generateFn: GeminiGenerateFn;
  if (_testGenerateFn) {
    generateFn = _testGenerateFn;
  } else {
    const client = new GoogleGenAI({ apiKey });
    generateFn = (params) => client.models.generateContent(params);
  }

  return {
    async complete(system, messages, tools) {
      try {
        const contents = mapGeminiMessages(messages);
        const config = {
          systemInstruction: system,
          maxOutputTokens: 1024,
          ...(tools.length > 0 ? { tools: mapGeminiTools(tools) } : {}),
        };
        const chain = orderForHistory(models, messages);
        const attempts: GeminiAttemptSummary[] = [];
        let lastError: unknown;

        for (const [index, current] of chain.entries()) {
          const outcome = await attemptGenerate(
            generateFn,
            { model: current, contents, config },
            timeoutMs,
          );
          if (outcome.ok) return ok(mapGeminiResponse(outcome.response, current));

          attempts.push(outcome.summary);
          lastError = outcome.error;
          const next = chain[index + 1];
          if (!outcome.retryable || next === undefined) break;
          logger?.warn(
            {
              fromModel: current,
              toModel: next,
              status: outcome.summary.status,
              reason: outcome.summary.reason,
            },
            'llm_model_fallback',
          );
        }

        const failure: GeminiChainFailure = { lastError, attempts };
        return err({ code: 'LLM_NETWORK_ERROR' as const, cause: failure });
      } catch (cause) {
        return err({ code: 'LLM_NETWORK_ERROR' as const, cause });
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Test double (fake)
// ---------------------------------------------------------------------------

type FakeCall = {
  system: string;
  messages: readonly LlmMessage[];
  tools: readonly LlmTool[];
};

const DEFAULT_RESPONSE: Result<LlmResponse, LlmError> = ok({
  text: 'fake reply',
  toolUses: [],
  stopReason: 'end_turn',
});

/**
 * Test double. Deterministic, programmable, records calls.
 *
 * Default = ok({ text: 'fake reply', toolUses: [], stopReason: 'end_turn' }).
 *
 * Behaviour:
 * - If a `script` array is provided, responses are dequeued in order. Once
 *   exhausted, subsequent calls return the default.
 * - queueResponse(r) pre-loads one response that is consumed on the next call
 *   (ahead of the script queue). After consumption, reverts to the next script
 *   item or the default.
 * - calls[] records every invocation in order for assertions.
 *
 * Mirrors createFakeMetaClient's API design.
 */
export const createFakeLlmAdapter = (
  script?: Array<Result<LlmResponse, LlmError>>,
): LlmAdapter & {
  calls: FakeCall[];
  queueResponse(r: Result<LlmResponse, LlmError>): void;
} => {
  const calls: FakeCall[] = [];
  const queue: Array<Result<LlmResponse, LlmError>> = script ? [...script] : [];
  let oneOff: Result<LlmResponse, LlmError> | null = null;

  return {
    calls,

    queueResponse(r) {
      oneOff = r;
    },

    async complete(system, messages, tools) {
      calls.push({ system, messages, tools });

      if (oneOff !== null) {
        const response = oneOff;
        oneOff = null;
        return response;
      }

      if (queue.length > 0) {
        return queue.shift()!;
      }

      return DEFAULT_RESPONSE;
    },
  };
};
