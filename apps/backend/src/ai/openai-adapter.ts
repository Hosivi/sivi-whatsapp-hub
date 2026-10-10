/**
 * openai-adapter.ts — OpenAI Chat Completions implementation of LlmAdapter
 * (functional DI, NO class, NO SDK dependency: plain global `fetch`, like
 * meta-client.ts does for the Graph API).
 *
 * Wire contract, checked 2026-10-10 against the official references:
 * - Create chat completion: https://developers.openai.com/api/docs/api-reference/chat/create
 *   Request: `model`, `messages` (`developer` replaces `system` for o1-and-newer
 *   reasoning models; `user`; `assistant` with optional `tool_calls`
 *   [{ id, type: "function", function: { name, arguments: <JSON string> } }];
 *   `tool` with `tool_call_id` + `content`), `tools` [{ type: "function",
 *   function: { name, description, parameters } }], `tool_choice` (omitted: the
 *   default is "auto" when tools are present), `reasoning_effort`,
 *   `max_completion_tokens` (includes reasoning tokens; `max_tokens` is deprecated).
 *   Response: `choices[0].message.content` (string | null),
 *   `choices[0].message.tool_calls[]`, `choices[0].finish_reason`
 *   ("stop" | "length" | "tool_calls" | "content_filter" | "function_call").
 * - Errors: https://developers.openai.com/api/docs/guides/error-codes — the body's
 *   `error.code` / `error.type` identify the cause (e.g. 429 `insufficient_quota`).
 * - gpt-6-luna: https://developers.openai.com/api/docs/models/gpt-6-luna — "Chat
 *   Completions supports function calling only with `reasoning_effort` set to
 *   `none`", so every request sends `reasoning_effort: "none"`.
 *
 * Security invariants:
 * - apiKey is only placed in the Authorization header; it is NEVER logged, never
 *   part of a returned error, never in the body.
 * - OpenAI `error.message` is dropped: it can echo a masked key fragment or input.
 * - Errors never carry the prompt, customer text or raw tool arguments.
 * - Never throws from complete(): every failure is a Result.
 */

import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type { LlmAdapter } from './llm-adapter.js';
import type { LlmError, LlmMessage, LlmResponse, LlmTool, ToolUseBlock } from './llm-types.js';
import { buildLlmUsage } from './llm-usage.js';

export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

/** Per-attempt timeout used when the caller does not inject one. */
export const DEFAULT_OPENAI_ATTEMPT_TIMEOUT_MS = 20_000;

/** Same output budget as the Gemini and Anthropic adapters. */
const MAX_COMPLETION_TOKENS = 1024;

/** Injectable transport — the global `fetch` satisfies it. Test seam. */
export type OpenAiFetch = (url: string, init: RequestInit) => Promise<Response>;

export type OpenAiAdapterOptions = {
  /** Per-attempt timeout in ms (AbortSignal.timeout). Default 20 000. */
  readonly timeoutMs?: number;
  /** Transport override for tests; defaults to the global fetch. */
  readonly fetchFn?: OpenAiFetch;
};

// ---------------------------------------------------------------------------
// Wire types (only the fields this adapter sends or reads)
// ---------------------------------------------------------------------------

type OpenAiToolCall = {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
};

type OpenAiMessage =
  | { readonly role: 'developer' | 'user' | 'assistant'; readonly content: string }
  | { readonly role: 'assistant'; readonly tool_calls: readonly OpenAiToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

type OpenAiFunctionTool = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

/**
 * Deterministic id for a tool-use block that arrived without one (Gemini often
 * returns empty functionCall ids). Derived from the block's position in the
 * history, so every attempt over the same history produces the same ids.
 */
const synthesizedToolCallId = (turnIndex: number, blockIndex: number): string =>
  `call_hub_${turnIndex}_${blockIndex}`;

/**
 * Maps the neutral history to Chat Completions messages.
 *
 * OpenAI requires every `tool` message to reference a non-empty `tool_call_id`
 * that matches a preceding assistant `tool_calls[].id`. Non-empty ids pass through
 * unchanged. Empty ids get a synthesized id, remembered until the matching tool
 * result arrives: results are paired by tool name first, then in order (the
 * orchestrator appends results in block order). Gemini-only metadata
 * (thoughtSignature, producerModel) is never sent.
 */
function mapOpenAiMessages(messages: readonly LlmMessage[]): OpenAiMessage[] {
  let pending: Array<{ readonly name: string; readonly id: string }> = [];

  return messages.map((msg, index): OpenAiMessage => {
    switch (msg.role) {
      case 'user':
      case 'assistant':
        return { role: msg.role, content: msg.content };
      case 'assistant-tool-use': {
        // A new tool-use turn supersedes ids still waiting from an older one.
        pending = [];
        return {
          role: 'assistant',
          tool_calls: msg.toolUses.map((tu, blockIndex): OpenAiToolCall => {
            let id = tu.id;
            if (id.length === 0) {
              id = synthesizedToolCallId(index, blockIndex);
              pending.push({ name: tu.name, id });
            }
            return {
              id,
              type: 'function',
              function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
            };
          }),
        };
      }
      case 'tool': {
        if (msg.toolUseId.length > 0) {
          return { role: 'tool', tool_call_id: msg.toolUseId, content: msg.content };
        }
        const byName = pending.findIndex((p) => p.name === msg.toolName);
        const [match] = pending.splice(byName === -1 ? 0 : byName, 1);
        return {
          role: 'tool',
          tool_call_id: match?.id ?? synthesizedToolCallId(index, 0),
          content: msg.content,
        };
      }
    }
  });
}

/** Maps LlmTool[] to function tools; the JSON Schema is passed as-is (as for Gemini). */
function mapOpenAiTools(tools: readonly LlmTool[]): OpenAiFunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses a tool-call `arguments` string; blank means "no arguments". */
function parseToolArguments(raw: unknown): Result<unknown, null> {
  if (typeof raw !== 'string') return err(null);
  if (raw.trim().length === 0) return ok({});
  try {
    return ok(JSON.parse(raw) as unknown);
  } catch {
    return err(null);
  }
}

function mapStopReason(finishReason: unknown, hasToolUses: boolean): LlmResponse['stopReason'] {
  if (hasToolUses) return 'tool_use';
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

/**
 * Maps a chat.completion body to LlmResponse. Tool calls are stamped with
 * `producerModel: openai:<model>` for model affinity on the follow-up turn.
 */
function mapOpenAiResponse(payload: unknown, model: string): Result<LlmResponse, LlmError> {
  const choice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = isRecord(choice) ? choice.message : null;
  if (!isRecord(choice) || !isRecord(message)) {
    return err({ code: 'LLM_BAD_RESPONSE', detail: 'OpenAI response has no choices[0].message' });
  }

  const toolUses: ToolUseBlock[] = [];
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    if (!isRecord(call) || call.type !== 'function' || !isRecord(call.function)) continue;
    const name = typeof call.function.name === 'string' ? call.function.name : '';
    const input = parseToolArguments(call.function.arguments);
    if (!input.ok) {
      // Raw arguments are never echoed: they may contain customer data.
      return err({
        code: 'LLM_BAD_RESPONSE',
        detail: `OpenAI tool call "${name}" has malformed JSON arguments`,
      });
    }
    toolUses.push({
      id: typeof call.id === 'string' ? call.id : '',
      name,
      input: input.value,
      producerModel: `openai:${model}`,
    });
  }

  const usage = mapOpenAiUsage(isRecord(payload) ? payload.usage : undefined);
  return ok({
    text: typeof message.content === 'string' ? message.content : null,
    toolUses,
    stopReason: mapStopReason(choice.finish_reason, toolUses.length > 0),
    ...(usage !== undefined ? { usage } : {}),
    answeredBy: { provider: 'openai', model },
  });
}

/**
 * Maps the chat.completion `usage` object onto the neutral LlmUsage. Fields per
 * https://developers.openai.com/api/docs/api-reference/chat/create (response
 * `usage`): `prompt_tokens`, `completion_tokens` (reasoning tokens included),
 * `total_tokens`, `completion_tokens_details.reasoning_tokens` and
 * `prompt_tokens_details.cached_tokens` (both breakdowns, not additions).
 * Absent or malformed usage → undefined; never throws.
 */
function mapOpenAiUsage(usage: unknown): LlmResponse['usage'] {
  if (!isRecord(usage)) return undefined;
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return buildLlmUsage({
    input: [usage.prompt_tokens],
    output: [usage.completion_tokens],
    reasoning: completionDetails.reasoning_tokens,
    cachedInput: promptDetails.cached_tokens,
    total: usage.total_tokens,
  });
}

/** HTTP failure → LLM_API_ERROR with status and OpenAI error.code/type (no message). */
function mapHttpError(status: number, payload: unknown): LlmError {
  const detail = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
  return {
    code: 'LLM_API_ERROR',
    status,
    ...(typeof detail.type === 'string' ? { errorType: detail.type } : {}),
    ...(typeof detail.code === 'string' ? { errorCode: detail.code } : {}),
  };
}

/**
 * AbortSignal.timeout rejects fetch / body reads with a DOMException named
 * TimeoutError. AbortError is accepted too: the timeout is the only abort source.
 */
const isTimeoutError = (error: unknown): boolean => {
  const name = typeof error === 'object' && error !== null ? Reflect.get(error, 'name') : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
};

/** Reads the body as JSON; undefined when it is not JSON. Throws only on transport errors. */
async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

/**
 * OpenAI Chat Completions adapter for one model. apiKey is NEVER logged.
 *
 * Every complete() is one attempt bounded by `timeoutMs` (AbortSignal.timeout
 * covers the request and the body read). Failures are returned, never thrown:
 * - HTTP non-2xx      → LLM_API_ERROR { status, errorCode?, errorType? }
 * - timeout           → LLM_TIMEOUT { timeoutMs }
 * - fetch rejected    → LLM_NETWORK_ERROR { cause }
 * - unusable 2xx body → LLM_BAD_RESPONSE (incl. malformed tool-call arguments)
 * Fallback across models is the model chain's job (model-chain.ts).
 *
 * @throws at construction (wiring time) when the key or the model is blank.
 */
export const createOpenAiAdapter = (
  apiKey: string,
  model: string,
  options: OpenAiAdapterOptions = {},
): LlmAdapter => {
  if (apiKey.trim().length === 0) {
    throw new Error('[openai-adapter] createOpenAiAdapter requires OPENAI_API_KEY');
  }
  const modelId = model.trim();
  if (modelId.length === 0) {
    throw new Error('[openai-adapter] createOpenAiAdapter requires a model');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_ATTEMPT_TIMEOUT_MS;
  const fetchFn: OpenAiFetch = options.fetchFn ?? ((url, init) => fetch(url, init));

  return {
    async complete(system, messages, tools) {
      try {
        const body = {
          model: modelId,
          messages: [{ role: 'developer', content: system }, ...mapOpenAiMessages(messages)],
          reasoning_effort: 'none',
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          ...(tools.length > 0 ? { tools: mapOpenAiTools(tools) } : {}),
        };

        let res: Response;
        let payload: unknown;
        try {
          res = await fetchFn(OPENAI_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
          payload = await readJsonBody(res);
        } catch (error) {
          if (isTimeoutError(error)) return err({ code: 'LLM_TIMEOUT', timeoutMs });
          return err({ code: 'LLM_NETWORK_ERROR', cause: error });
        }

        if (!res.ok) return err(mapHttpError(res.status, payload));
        return mapOpenAiResponse(payload, modelId);
      } catch (cause) {
        return err({ code: 'LLM_NETWORK_ERROR', cause });
      }
    },
  };
};
