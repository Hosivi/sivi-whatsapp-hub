/**
 * drizzle.config.ts — Drizzle Kit configuration.
 *
 * Used only by the drizzle-kit CLI (generate, migrate, studio).
 * The app runtime uses createDbClient() in src/db/client.ts instead.
 *
 * Re-running `pnpm drizzle-kit generate` will OVERWRITE 0000_contacts.sql.
 * After re-generating, the hand-appended RLS + app_rls block (starting at the
 * "-- RLS + role" comment) MUST be re-appended from design.md.
 */

import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_ADMIN_URL) {
  throw new Error('DATABASE_ADMIN_URL is required for drizzle-kit commands');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_ADMIN_URL,
  },
});
