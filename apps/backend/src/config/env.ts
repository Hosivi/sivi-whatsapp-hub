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
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates process.env. Throws a ZodError if required variables are
 * missing or invalid. Call once at process startup before any other module.
 */
export const loadEnv = (): Env => envSchema.parse(process.env);
