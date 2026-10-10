/**
 * model-chain.ts — Ordered cross-provider LLM model chain (functional DI, NO class).
 *
 * `createModelChainLlm(entries, deps)` turns the AI_MODEL entries (Gemini and/or
 * OpenAI models, in order) into one LlmAdapter that tries them in order with the
 * SAME rules as the T4 Gemini chain:
 * - falls back on HTTP 404/408/429/500/502/503/504, the per-attempt timeout, network
 *   errors without HTTP status, and unusable responses (e.g. malformed tool-call
 *   arguments — model nondeterminism, another model can answer);
 * - stops on any other HTTP status — notably 400/401/403 (bad request, invalid or
 *   unauthorized key), which would fail the same way again;
 * - logs every fallback as warn `llm_model_fallback` { fromModel, toModel, status,
 *   reason } with `provider:model` labels — never keys, prompts or customer text;
 * - when every attempt fails, returns LLM_NETWORK_ERROR whose cause is a
 *   ModelChainFailure { lastError, attempts } (the T4 GeminiChainFailure shape);
 * - on success, stamps the response with `answeredBy` (the entry that answered)
 *   and `fallbackAttempts` (the failed attempts before it, possibly empty); the
 *   answering adapter's `usage` passes through unchanged.
 *
 * Each entry is served by a single-model provider adapter built once at wiring
 * time by `deps.providers[provider](model, { timeoutMs })`; that adapter owns its
 * per-attempt timeout. Gemini entries reuse `createGeminiAdapter` unchanged with a
 * one-model list (its internal chain then has nothing to fall back to), so T3
 * thought signatures and T4 behavior stay exactly as tested.
 *
 * Model affinity: a successful tool-use turn is stamped `producerModel:
 * <provider>:<model>`; when that turn is replayed, its producer goes first.
 * Cross-provider replay stays valid: the OpenAI adapter ignores Gemini thought
 * signatures and synthesizes ids for empty Gemini call ids; OpenAI-produced
 * calls replayed to Gemini simply carry no signature.
 */

import { err, ok } from '../shared/result.js';
import { FALLBACK_HTTP_STATUSES, orderForHistory } from './llm-adapter.js';
import type { GeminiChainFailure, LlmAdapter } from './llm-adapter.js';
import { modelEntryKey } from './llm-types.js';
import type {
  LlmAttemptFailureReason,
  LlmAttemptSummary,
  LlmError,
  LlmModelEntry,
  LlmProvider,
  LlmResponse,
} from './llm-types.js';

/** Per-attempt timeout used when the caller does not inject one. */
export const DEFAULT_MODEL_CHAIN_TIMEOUT_MS = 20_000;

/** Why one model attempt failed. */
export type ModelAttemptFailureReason = LlmAttemptFailureReason;

/** One failed attempt of the chain. Safe to log: no key, prompt or customer text. */
export type ModelAttemptSummary = LlmAttemptSummary;

/** `cause` of the LLM_NETWORK_ERROR returned when the chain ends without an answer. */
export type ModelChainFailure = {
  /** Last attempt's error (provider SDK error, LlmError or network error). */
  readonly lastError: unknown;
  /** Every attempt in the order it ran. */
  readonly attempts: readonly ModelAttemptSummary[];
};

/** Payload of the `llm_model_fallback` warning. */
export type ModelChainFallbackEvent = {
  readonly fromModel: string;
  readonly toModel: string;
  readonly status: number | null;
  readonly reason: ModelAttemptFailureReason;
};

/** Minimal logger dependency — a pino Logger satisfies it. */
export type ModelChainLogger = {
  warn(event: ModelChainFallbackEvent, msg: string): void;
};

/** Builds the single-model adapter that serves one entry of a provider. */
export type ModelAttemptFactory = (
  model: string,
  options: { readonly timeoutMs: number },
) => LlmAdapter;

export type ModelChainDeps = {
  /** One factory per provider used by the entries (missing → wiring error). */
  readonly providers: Partial<Record<LlmProvider, ModelAttemptFactory>>;
  /** Receives one warn (`llm_model_fallback`) per fallback. */
  readonly logger?: ModelChainLogger;
  /** Per-attempt timeout in ms handed to every factory. Default 20 000. */
  readonly timeoutMs?: number;
};

/** The chain label of an entry: `<provider>:<model>` (re-exported; defined in llm-types). */
export { modelEntryKey };

type ClassifiedFailure = {
  readonly reason: ModelAttemptFailureReason;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly lastError: unknown;
};

const isGeminiChainFailure = (cause: unknown): cause is GeminiChainFailure =>
  typeof cause === 'object' &&
  cause !== null &&
  Array.isArray((cause as { attempts?: unknown }).attempts);

const isRetryableStatus = (status: number): boolean => FALLBACK_HTTP_STATUSES.has(status);

/** Maps one provider adapter's LlmError onto the T4 classification. */
function classifyFailure(error: LlmError): ClassifiedFailure {
  switch (error.code) {
    case 'LLM_API_ERROR':
      // No status: the request never got an HTTP answer (connection error).
      return error.status === undefined
        ? { reason: 'network_error', status: null, retryable: true, lastError: error }
        : {
            reason: 'http_error',
            status: error.status,
            retryable: isRetryableStatus(error.status),
            lastError: error,
          };
    case 'LLM_TIMEOUT':
      return { reason: 'timeout', status: null, retryable: true, lastError: error };
    case 'LLM_BAD_RESPONSE':
      return { reason: 'bad_response', status: null, retryable: true, lastError: error };
    case 'LLM_NETWORK_ERROR': {
      // A single-model Gemini adapter reports its one attempt as a GeminiChainFailure.
      const { cause } = error;
      if (isGeminiChainFailure(cause)) {
        const last = cause.attempts[cause.attempts.length - 1];
        if (last !== undefined) {
          return {
            reason: last.reason,
            status: last.status,
            retryable:
              last.reason !== 'http_error' ||
              (last.status !== null && isRetryableStatus(last.status)),
            lastError: cause.lastError,
          };
        }
      }
      return { reason: 'network_error', status: null, retryable: true, lastError: cause ?? error };
    }
  }
}

/** Stamps the chain label on every tool-use block (affinity key for the follow-up). */
const stampProducer = (response: LlmResponse, key: string): LlmResponse =>
  response.toolUses.length === 0
    ? response
    : { ...response, toolUses: response.toolUses.map((tu) => ({ ...tu, producerModel: key })) };

/**
 * Builds the ordered cross-provider chain. Every factory runs once here, so a
 * misconfigured provider fails at startup, not per request.
 *
 * @throws at construction when there is no entry or a provider has no factory.
 */
export const createModelChainLlm = (
  entries: readonly LlmModelEntry[],
  deps: ModelChainDeps,
): LlmAdapter => {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_MODEL_CHAIN_TIMEOUT_MS;
  const adapters = new Map<
    string,
    { readonly entry: LlmModelEntry; readonly adapter: LlmAdapter }
  >();
  for (const entry of entries) {
    const key = modelEntryKey(entry);
    if (adapters.has(key)) continue; // duplicates: first occurrence wins
    const factory = deps.providers[entry.provider];
    if (factory === undefined) {
      throw new Error(`[model-chain] no adapter factory for provider "${entry.provider}"`);
    }
    adapters.set(key, {
      entry: { provider: entry.provider, model: entry.model },
      adapter: factory(entry.model, { timeoutMs }),
    });
  }
  if (adapters.size === 0) {
    throw new Error('[model-chain] createModelChainLlm requires at least one model');
  }
  const keys = [...adapters.keys()];
  const { logger } = deps;

  return {
    async complete(system, messages, tools) {
      const chain = orderForHistory(keys, messages);
      const attempts: ModelAttemptSummary[] = [];
      let lastError: unknown;

      for (const [index, key] of chain.entries()) {
        const served = adapters.get(key);
        if (served === undefined) continue;

        let failure: ClassifiedFailure;
        try {
          const result = await served.adapter.complete(system, messages, tools);
          if (result.ok) {
            // Success report: the chain entry is the authoritative answering identity;
            // the attempts that failed before it are reported so callers can account them.
            return ok({
              ...stampProducer(result.value, key),
              answeredBy: served.entry,
              fallbackAttempts: [...attempts],
            });
          }
          failure = classifyFailure(result.error);
        } catch (cause) {
          // Adapters must not throw; contain it as a network error anyway.
          failure = { reason: 'network_error', status: null, retryable: true, lastError: cause };
        }

        attempts.push({ model: key, reason: failure.reason, status: failure.status });
        lastError = failure.lastError;
        const next = chain[index + 1];
        if (!failure.retryable || next === undefined) break;
        logger?.warn(
          { fromModel: key, toModel: next, status: failure.status, reason: failure.reason },
          'llm_model_fallback',
        );
      }

      const chainFailure: ModelChainFailure = { lastError, attempts };
      return err({ code: 'LLM_NETWORK_ERROR' as const, cause: chainFailure });
    },
  };
};
