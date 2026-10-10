/**
 * llm-usage.ts — Token usage normalization and per-reply accounting (pure, no I/O).
 *
 * - buildLlmUsage: maps provider token counts onto the neutral LlmUsage shape; used
 *   by the Gemini and OpenAI adapters so both normalize identically.
 * - tallyLlmCall: folds one successful LLM call into the running per-reply tally
 *   that runAiReply persists to ai_reply_usage and logs.
 *
 * Nothing here ever sees prompts, customer text or keys — only counts and labels.
 */

import { modelEntryKey } from './llm-types.js';
import type { LlmAttemptSummary, LlmModelEntry, LlmResponse, LlmUsage } from './llm-types.js';

// ---------------------------------------------------------------------------
// Per-call normalization
// ---------------------------------------------------------------------------

/** A usable provider token count (finite, >= 0, truncated); undefined otherwise. */
export const toTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;

/** Raw provider counts; `input` / `output` entries are summed (missing ones count 0). */
export type RawUsageCounts = {
  readonly input: readonly unknown[];
  readonly output: readonly unknown[];
  readonly reasoning?: unknown;
  readonly cachedInput?: unknown;
  readonly total?: unknown;
};

/**
 * Builds the neutral usage of one call. Returns undefined when the provider
 * reported no usable count at all (absent or malformed usage never throws).
 */
export function buildLlmUsage(raw: RawUsageCounts): LlmUsage | undefined {
  const inputs = raw.input.map(toTokenCount);
  const outputs = raw.output.map(toTokenCount);
  const reasoningTokens = toTokenCount(raw.reasoning);
  const cachedInputTokens = toTokenCount(raw.cachedInput);
  const total = toTokenCount(raw.total);
  const reported = [...inputs, ...outputs, reasoningTokens, cachedInputTokens, total];
  if (reported.every((count) => count === undefined)) return undefined;

  const sum = (counts: ReadonlyArray<number | undefined>): number =>
    counts.reduce<number>((acc, count) => acc + (count ?? 0), 0);
  const inputTokens = sum(inputs);
  const outputTokens = sum(outputs);
  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    totalTokens: total ?? inputTokens + outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Per-reply tally (runAiReply)
// ---------------------------------------------------------------------------

/** A failed model attempt, tagged with the 1-based LLM call of the reply it belongs to. */
export type AiReplyFallbackAttempt = LlmAttemptSummary & { readonly call: number };

/** Running totals over every successful LLM call of one AI reply. */
export type AiReplyUsageTally = {
  readonly llmCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** null until some call reports reasoning tokens. */
  readonly reasoningTokens: number | null;
  /** null until some call reports cached input tokens. */
  readonly cachedInputTokens: number | null;
  readonly totalTokens: number;
  readonly fallbackAttempts: readonly AiReplyFallbackAttempt[];
  /** Distinct `<provider>:<model>` that answered, in first-use order. */
  readonly modelsUsed: readonly string[];
  /** Model of the latest call that reported one — the one that produced the reply. */
  readonly answeredBy: LlmModelEntry | null;
};

export const EMPTY_USAGE_TALLY: AiReplyUsageTally = {
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  cachedInputTokens: null,
  totalTokens: 0,
  fallbackAttempts: [],
  modelsUsed: [],
  answeredBy: null,
};

const addOptional = (acc: number | null, count: number | undefined): number | null =>
  count === undefined ? acc : (acc ?? 0) + count;

/** Folds one successful LLM call into the tally (returns a new tally). */
export function tallyLlmCall(tally: AiReplyUsageTally, response: LlmResponse): AiReplyUsageTally {
  const call = tally.llmCalls + 1;
  const { usage, answeredBy } = response;
  const key = answeredBy === undefined ? undefined : modelEntryKey(answeredBy);
  return {
    llmCalls: call,
    inputTokens: tally.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: tally.outputTokens + (usage?.outputTokens ?? 0),
    reasoningTokens: addOptional(tally.reasoningTokens, usage?.reasoningTokens),
    cachedInputTokens: addOptional(tally.cachedInputTokens, usage?.cachedInputTokens),
    totalTokens: tally.totalTokens + (usage?.totalTokens ?? 0),
    fallbackAttempts: [
      ...tally.fallbackAttempts,
      ...(response.fallbackAttempts ?? []).map((attempt) => ({ call, ...attempt })),
    ],
    modelsUsed:
      key === undefined || tally.modelsUsed.includes(key)
        ? tally.modelsUsed
        : [...tally.modelsUsed, key],
    answeredBy: answeredBy ?? tally.answeredBy,
  };
}
