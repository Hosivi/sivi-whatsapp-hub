/**
 * env.ts — Environment configuration validation.
 *
 * Parses process.env with Zod and fails-fast at startup if required variables
 * are missing or invalid. Throwing here is intentional: misconfiguration is an
 * infrastructure failure, not a domain Result error.
 */

import { z } from 'zod';

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
  ENABLE_DEV_ENDPOINTS: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates process.env. Throws a ZodError if required variables are
 * missing or invalid. Call once at process startup before any other module.
 */
export const loadEnv = (): Env => envSchema.parse(process.env);
