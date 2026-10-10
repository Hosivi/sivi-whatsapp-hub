/**
 * env.ts — Environment configuration validation.
 *
 * Parses process.env with Zod and fails-fast at startup if required variables
 * are missing or invalid. Throwing here is intentional: misconfiguration is an
 * infrastructure failure, not a domain Result error.
 */

import { z } from 'zod';

/**
 * Default ordered Gemini model chain: the fast flash-lite first, flash as fallback.
 * gemini-2.5-* is not used: it answers 404 "no longer available to new users".
 */
export const DEFAULT_AI_MODEL = 'gemini-3.5-flash-lite,gemini-3.5-flash';

/** Default per-attempt LLM timeout (ms) before falling back to the next model. */
export const DEFAULT_AI_TIMEOUT_MS = 20_000;

/** Splits AI_MODEL into an ordered model list: comma-separated, trimmed, empties dropped. */
export const parseAiModelList = (raw: string): string[] =>
  raw
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

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
  // Ordered, comma-separated Gemini model chain for AI replies (a single model is
  // also valid). The adapter tries them in order and falls back on retryable
  // failures. Parsed into LoadedEnv.AI_MODELS; must list at least one model.
  AI_MODEL: z
    .string()
    .default(DEFAULT_AI_MODEL)
    .refine((raw) => parseAiModelList(raw).length > 0, {
      message: 'AI_MODEL must list at least one model (comma-separated)',
    }),
  // Optional per-attempt LLM timeout in ms. LoadedEnv applies DEFAULT_AI_TIMEOUT_MS.
  // Kept optional in Env so existing Env literals stay valid.
  AI_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Env plus the derived LLM settings, resolved once at startup by loadEnv(). */
export type LoadedEnv = Env & {
  /** Ordered, non-empty model fallback chain parsed from AI_MODEL. */
  readonly AI_MODELS: readonly string[];
  /** Per-attempt LLM timeout in ms (AI_TIMEOUT_MS or DEFAULT_AI_TIMEOUT_MS). */
  readonly AI_TIMEOUT_MS: number;
};

/**
 * Parses and validates process.env. Throws a ZodError if required variables are
 * missing or invalid. Call once at process startup before any other module.
 */
export const loadEnv = (): LoadedEnv => {
  const env = envSchema.parse(process.env);
  return {
    ...env,
    AI_MODELS: parseAiModelList(env.AI_MODEL),
    AI_TIMEOUT_MS: env.AI_TIMEOUT_MS ?? DEFAULT_AI_TIMEOUT_MS,
  };
};
