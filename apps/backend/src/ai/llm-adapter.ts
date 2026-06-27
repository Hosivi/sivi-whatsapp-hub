/**
 * llm-adapter.ts — Injectable LLM egress (functional DI, NO class).
 *
 * Mirrors the MetaClient pattern established for WhatsApp egress (ADR-0017).
 *
 * Exports:
 * - LlmAdapter: injectable contract (interface)
 * - createAnthropicAdapter(apiKey, model): Anthropic SDK implementation (retained, not default)
 * - createGeminiAdapter(apiKey, model, _testGenerateFn?): Gemini SDK implementation (ACTIVE default)
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
      // Gemini: model turn with functionCall parts
      return {
        role: 'model',
        parts: msg.toolUses.map((tu) => ({
          functionCall: {
            id: tu.id,
            name: tu.name,
            args: tu.input as Record<string, unknown>,
          },
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

/** Maps a Gemini GenerateContentResponse to our neutral LlmResponse. */
function mapGeminiResponse(response: GenerateContentResponse): LlmResponse {
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

  return { text, toolUses, stopReason };
}

/**
 * Internal type for the stub-injectable generate function (test seam).
 * Matches the signature of `client.models.generateContent`.
 */
export type GeminiGenerateFn = (
  params: GenerateContentParameters,
) => Promise<GenerateContentResponse>;

/**
 * Real Gemini implementation. apiKey is NEVER logged.
 * Catches all SDK throws and maps them to LlmError (never throws to caller).
 *
 * @param apiKey         - Google AI API key. Bound to the SDK client, not logged.
 * @param model          - Gemini model ID (e.g. 'gemini-2.5-flash').
 * @param _testGenerateFn - Optional test seam: inject a stubbed generate function
 *                          instead of creating a real GoogleGenAI client.
 *                          ONLY for unit tests — never set in production.
 */
export const createGeminiAdapter = (
  apiKey: string,
  model: string,
  _testGenerateFn?: GeminiGenerateFn,
): LlmAdapter => {
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
        const response = await generateFn({
          model,
          contents: mapGeminiMessages(messages),
          config: {
            systemInstruction: system,
            maxOutputTokens: 1024,
            ...(tools.length > 0 ? { tools: mapGeminiTools(tools) } : {}),
          },
        });
        return ok(mapGeminiResponse(response));
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
