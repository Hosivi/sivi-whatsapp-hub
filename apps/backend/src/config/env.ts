/**
 * env.ts — Environment configuration validation.
 *
 * Parses process.env with Zod and fails-fast at startup if required variables
 * are missing or invalid. Throwing here is intentional: misconfiguration is an
 * infrastructure failure, not a domain Result error.
 */

import { z } from 'zod';
import { LLM_PROVIDERS } from '../ai/llm-types.js';
import type { LlmModelEntry, LlmProvider } from '../ai/llm-types.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';

/**
 * Default ordered Gemini model chain: the fast flash-lite first, flash as fallback.
 * gemini-2.5-* is not used: it answers 404 "no longer available to new users".
 */
export const DEFAULT_AI_MODEL = 'gemini-3.5-flash-lite,gemini-3.5-flash';

/** Default per-attempt LLM timeout (ms) before falling back to the next model. */
export const DEFAULT_AI_TIMEOUT_MS = 20_000;

/**
 * Splits AI_MODEL into an ordered list of raw entries: comma-separated, trimmed,
 * empties dropped. Entries keep their provider prefix (e.g. `openai:gpt-6-luna`).
 */
export const parseAiModelList = (raw: string): string[] =>
  raw
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

const isLlmProvider = (value: string): value is LlmProvider =>
  (LLM_PROVIDERS as readonly string[]).includes(value);

/**
 * Parses one AI_MODEL entry: `<provider>:<model>` or a bare `<model>`, which means
 * `gemini` (backward compatible with the Gemini-only chain). The prefix is the text
 * before the FIRST colon, trimmed and case-insensitive; the rest is the model ID,
 * so IDs that contain colons (OpenAI fine-tunes) still work behind a prefix.
 * The error text names the entry, never a secret.
 */
export const parseAiModelEntry = (raw: string): Result<LlmModelEntry, string> => {
  const entry = raw.trim();
  const separator = entry.indexOf(':');
  if (separator === -1) return ok({ provider: 'gemini', model: entry });

  const provider = entry.slice(0, separator).trim().toLowerCase();
  const model = entry.slice(separator + 1).trim();
  if (!isLlmProvider(provider)) {
    return err(
      `AI_MODEL entry "${entry}" has an unknown provider prefix "${provider}" ` +
        `(supported: ${LLM_PROVIDERS.join(', ')}; no prefix means gemini)`,
    );
  }
  if (model.length === 0) {
    return err(`AI_MODEL entry "${entry}" has no model after the "${provider}:" prefix`);
  }
  return ok({ provider, model });
};

/** True when AI_MODEL lists at least one `openai:` entry. */
const listsOpenAiModel = (rawAiModel: string): boolean =>
  parseAiModelList(rawAiModel).some((entry) => {
    const parsed = parseAiModelEntry(entry);
    return parsed.ok && parsed.value.provider === 'openai';
  });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().min(1),
  AUTH_MODE: z.enum(['dev-header', 'jwt']),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.string().default('info'),
  // WhatsApp Cloud API — global credentials (one Meta App per Hub instance).
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  // Low-privilege DB connection for the app_webhook role (cross-tenant lookup).
  DATABASE_WEBHOOK_URL: z.string().min(1),
  // Optional: prod password for app_webhook role (mirrors APP_RLS_PASSWORD).
  APP_WEBHOOK_PASSWORD: z.string().optional(),
  // Dev-only: mount /dev/* routes + permissive CORS when true. Default false = prod-safe.
  // Explicit string-equality gate: ONLY the literal "true" enables dev. Any other value
  // (unset, "false", "0", "no", …) yields false. z.coerce.boolean() is unsafe here because
  // it coerces every non-empty string (including "false") to true.
  ENABLE_DEV_ENDPOINTS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Meta Graph API version for outbound sends (injected to createMetaClient). Default v21.0.
  WHATSAPP_META_API_VERSION: z.string().min(1).default('v21.0'),
  // Optional: select the WhatsApp egress provider. Defaults to Meta Cloud API.
  // Explicit string-equality gate — ONLY the literal 'dialog360' selects 360dialog.
  WHATSAPP_PROVIDER: z.enum(['meta', 'dialog360']).optional(),
  // Required when WHATSAPP_PROVIDER=dialog360. Sandbox: https://waba-sandbox.360dialog.io/v1
  // Production: https://waba-v2.360dialog.io
  DIALOG360_BASE_URL: z.string().optional(),
  // Anthropic API key — retained for the createAnthropicAdapter (not wired as default).
  // Can still be used if the active adapter is switched to Anthropic.
  ANTHROPIC_API_KEY: z.string().optional(),
  // Google Gemini API key for the real LLM adapter (ACTIVE default).
  // Optional when ENABLE_DEV_ENDPOINTS=true (fake LLM adapter is used instead).
  // MUST be set in production. Explicit string gate — never coerced to boolean.
  GEMINI_API_KEY: z.string().optional(),
  // OpenAI API key — required (non-blank) only when AI_MODEL lists an `openai:` entry;
  // validated below. Never logged and never echoed in validation errors.
  OPENAI_API_KEY: z.string().optional(),
  // Ordered, comma-separated model chain for AI replies (a single model is also
  // valid). Each entry is `<provider>:<model>` (gemini | openai) or a bare Gemini
  // model. The chain tries them in order and falls back on retryable failures.
  // Parsed into LoadedEnv.AI_MODELS / AI_MODEL_ENTRIES; must list at least one model.
  AI_MODEL: z
    .string()
    .default(DEFAULT_AI_MODEL)
    .refine((raw) => parseAiModelList(raw).length > 0, {
      message: 'AI_MODEL must list at least one model (comma-separated)',
    })
    .superRefine((raw, ctx) => {
      for (const entry of parseAiModelList(raw)) {
        const parsed = parseAiModelEntry(entry);
        if (!parsed.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
      }
    }),
  // Optional per-attempt LLM timeout in ms. LoadedEnv applies DEFAULT_AI_TIMEOUT_MS.
  // Kept optional in Env so existing Env literals stay valid.
  AI_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

/** Cross-field rules. The issue names the variable only — never its value. */
const validatedEnvSchema = envSchema.superRefine((env, ctx) => {
  if (listsOpenAiModel(env.AI_MODEL) && (env.OPENAI_API_KEY ?? '').trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when AI_MODEL lists an openai: entry',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/** Env plus the derived LLM settings, resolved once at startup by loadEnv(). */
export type LoadedEnv = Env & {
  /** Ordered, non-empty raw AI_MODEL entries (provider prefixes kept as written). */
  readonly AI_MODELS: readonly string[];
  /** Ordered, non-empty model chain parsed from AI_MODEL (unprefixed = gemini). */
  readonly AI_MODEL_ENTRIES: readonly LlmModelEntry[];
  /** Per-attempt LLM timeout in ms (AI_TIMEOUT_MS or DEFAULT_AI_TIMEOUT_MS). */
  readonly AI_TIMEOUT_MS: number;
};

/** Parses already-validated raw entries; a failure here is a programming error. */
const toModelEntries = (rawEntries: readonly string[]): LlmModelEntry[] =>
  rawEntries.map((entry) => {
    const parsed = parseAiModelEntry(entry);
    if (!parsed.ok) throw new Error(`[env] ${parsed.error}`);
    return parsed.value;
  });

/**
 * Parses and validates process.env. Throws a ZodError if required variables are
 * missing or invalid. Call once at process startup before any other module.
 */
export const loadEnv = (): LoadedEnv => {
  const env = validatedEnvSchema.parse(process.env);
  const aiModels = parseAiModelList(env.AI_MODEL);
  return {
    ...env,
    AI_MODELS: aiModels,
    AI_MODEL_ENTRIES: toModelEntries(aiModels),
    AI_TIMEOUT_MS: env.AI_TIMEOUT_MS ?? DEFAULT_AI_TIMEOUT_MS,
  };
};
