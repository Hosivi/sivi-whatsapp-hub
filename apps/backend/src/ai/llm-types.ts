/**
 * llm-types.ts — Provider-neutral LLM message and response shapes.
 *
 * No Anthropic SDK imports here — these types are consumed by the orchestrator,
 * tool registry, and system prompt builder without coupling to any vendor.
 *
 * Design invariant (D8): customer text is ALWAYS role 'user'. The system prompt
 * is passed separately to `LlmAdapter.complete()` so the customer can never
 * rewrite the agent's instructions via prompt injection.
 */

/** A single conversation message (provider-neutral). */
export type LlmMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string }
  /**
   * Assistant tool-use turn: the model requested one or more tool calls.
   * Fed back to the next complete() call so the model sees its own tool requests.
   * Anthropic maps this to role 'assistant' + content blocks of type 'tool_use'.
   * Gemini maps this to role 'model' + functionCall parts.
   */
  | { readonly role: 'assistant-tool-use'; readonly toolUses: readonly ToolUseBlock[] }
  /**
   * Tool result fed back to the model after the app executes a tool_use block.
   * toolName is required for Gemini's functionResponse.name field.
   * Anthropic uses only toolUseId (tool_use_id in tool_result block).
   */
  | {
      readonly role: 'tool';
      readonly toolUseId: string;
      readonly toolName: string;
      readonly content: string;
    };

/** A tool the model MAY invoke — name + JSON-schema params only (no function reference). */
export type LlmTool = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object describing the tool's input parameters. */
  readonly inputSchema: Record<string, unknown>;
};

/** One tool_use block the model emitted. The app maps name → registry → execution. */
export type ToolUseBlock = {
  /** toolUseId — echoed back in the 'tool' result message. */
  readonly id: string;
  readonly name: string;
  /** RAW model output — Zod-validated by the registry before use. */
  readonly input: unknown;
  /**
   * Gemini-only, provider-opaque thought signature (base64) returned on the
   * functionCall part. Gemini 3.x requires it to be echoed back unchanged on the
   * same functionCall part when the tool-use turn is replayed in history.
   * Absent for blocks that had none; ignored by every other adapter. Never log it.
   */
  readonly thoughtSignature?: string;
  /**
   * Provider-opaque ID of the model that emitted this block. When the tool-use turn
   * is replayed, the model chain tries this model first (model affinity — e.g. with
   * its own Gemini thought signatures). The Gemini adapter stamps the bare model ID;
   * the OpenAI adapter and the cross-provider chain stamp `<provider>:<model>`.
   * Never sent to any provider.
   */
  readonly producerModel?: string;
};

/** LLM providers an AI_MODEL entry may name (`<provider>:<model>`). */
export const LLM_PROVIDERS = ['gemini', 'openai'] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** One entry of the ordered model chain: which provider serves which model ID. */
export type LlmModelEntry = {
  readonly provider: LlmProvider;
  readonly model: string;
};

/** Adapter response. Either plain text to send, and/or tool_use blocks to execute. */
export type LlmResponse = {
  /** Assistant prose; may be null on a pure tool turn. */
  readonly text: string | null;
  /** Empty array = no tools requested this turn. */
  readonly toolUses: readonly ToolUseBlock[];
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
};

/** Errors the adapter may return — never thrown, always a Result. */
export type LlmError =
  | {
      readonly code: 'LLM_API_ERROR';
      readonly status?: number;
      readonly detail?: string;
      /** Provider error code when the body carries one (OpenAI `error.code`). */
      readonly errorCode?: string;
      /** Provider error type when the body carries one (OpenAI `error.type`). */
      readonly errorType?: string;
    }
  | { readonly code: 'LLM_NETWORK_ERROR'; readonly cause?: unknown }
  | { readonly code: 'LLM_BAD_RESPONSE'; readonly detail?: string }
  /** The attempt did not finish within its per-attempt timeout and was aborted. */
  | { readonly code: 'LLM_TIMEOUT'; readonly timeoutMs: number };
