/**
 * migrate.ts — Idempotent migration runner.
 *
 * Reads drizzle/0000_contacts.sql and executes it via the privileged adminSql
 * connection. Idempotent / safe to re-run: tables and indexes use IF NOT EXISTS;
 * the CHECK constraint and RLS policy use DROP ... IF EXISTS before (re)create;
 * ALTER TABLE ... ENABLE / FORCE RLS are no-ops when already set; and CREATE ROLE
 * is wrapped in a DO/EXCEPTION block (see makeIdempotent) that re-syncs the role
 * password on a re-run.
 *
 * WARNING — drizzle-kit regen footgun:
 *   Running `pnpm drizzle-kit generate` OVERWRITES drizzle/0000_contacts.sql and
 *   ERASES the hand-appended RLS + role block at the end of the file.
 *   After any re-generation, re-append the RLS + app_rls role block manually.
 *   See the comment at the bottom of drizzle/0000_contacts.sql for the exact SQL.
 *
 * CREATE ROLE is NOT idempotent in Postgres < 16. The migration guards it with:
 *   DO $$ BEGIN
 *     CREATE ROLE app_rls ...;
 *   EXCEPTION WHEN duplicate_object THEN NULL;
 *   END $$;
 * This allows safe re-runs in production where the role may already exist.
 *
 * Usage (as a standalone script — called before the server starts):
 *   node --loader ts-node/esm src/db/migrate.ts
 * Or via the package.json "migrate" script:
 *   pnpm migrate
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { Env } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Relative to compiled output: apps/backend/dist/db/migrate.js → ../../drizzle/
// Ordered list of migration files. Applied in array order. APPEND new files here.
const MIGRATION_FILES = [
  '0000_contacts.sql',
  '0001_routing.sql',
  '0002_whatsapp.sql',
  '0003_outbound.sql',
  '0004_tenant_ai_config.sql',
] as const;
const MIGRATIONS_DIR = join(__dirname, '../../drizzle');

/**
 * Replaces the bare CREATE ROLE line with an idempotent DO block.
 *
 * appRlsPassword — supplied from APP_RLS_PASSWORD; MUST match the password in DATABASE_URL.
 * appWebhookPassword — optional; defaults to 'app_webhook'. When provided, rewrites
 *   BOTH the CREATE and ALTER password literals inside the DO/EXCEPTION block for
 *   the app_webhook role in 0002_whatsapp.sql. The 3rd param is OPTIONAL so that
 *   existing 2-arg callers (migrate.int.test.ts:35, migrate.routing.int.test.ts:44,117)
 *   continue to compile and run unchanged — they do not connect as app_webhook.
 *
 * A replacement FUNCTION is required for the app_rls branch: a replacement STRING
 * would treat `$$` dollar-quote delimiters as `$`-escapes and corrupt the DO block.
 */
export function makeIdempotent(
  sql: string,
  appRlsPassword: string,
  appWebhookPassword = 'app_webhook', // optional default — keeps existing 2-arg callers compiling
): string {
  const safeRls = appRlsPassword.replace(/'/g, "''");
  const safeWh = appWebhookPassword.replace(/'/g, "''");

  // Rewrite app_rls CREATE ROLE line → idempotent DO block.
  let out = sql.replace(
    /CREATE ROLE app_rls[^\n;]+;/,
    () => `DO $$
BEGIN
  CREATE ROLE app_rls LOGIN PASSWORD '${safeRls}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE app_rls LOGIN PASSWORD '${safeRls}';
END
$$;`,
  );

  // Rewrite app_webhook CREATE + ALTER password literals in 0002_whatsapp.sql.
  // The migration already uses a DO/EXCEPTION guard; we only need to substitute
  // the password strings so prod stays in sync with DATABASE_WEBHOOK_URL credentials.
  out = out
    .replace(
      /CREATE ROLE app_webhook LOGIN PASSWORD '[^']*'/,
      `CREATE ROLE app_webhook LOGIN PASSWORD '${safeWh}'`,
    )
    .replace(
      /ALTER ROLE app_webhook LOGIN PASSWORD '[^']*'/,
      `ALTER ROLE app_webhook LOGIN PASSWORD '${safeWh}'`,
    );

  return out;
}

/**
 * Runs the migration SQL via the privileged adminSql connection.
 * Creates the contacts table, indexes, RLS policy, and app_rls role.
 *
 * @param env - Parsed environment configuration (DATABASE_ADMIN_URL required).
 */
export async function runMigration(env: Env): Promise<void> {
  // app_rls role password — sourced from env (never a source literal); it MUST
  // match the app_rls password embedded in DATABASE_URL.
  const appRlsPassword = process.env.APP_RLS_PASSWORD ?? 'app_rls';
  // app_webhook role password — sourced from APP_WEBHOOK_PASSWORD (mirrors APP_RLS_PASSWORD).
  // Default 'app_webhook' matches the in-SQL literal for local/test environments.
  const appWebhookPassword = process.env.APP_WEBHOOK_PASSWORD ?? 'app_webhook';
  const adminSql = postgres(env.DATABASE_ADMIN_URL, { max: 1 });

  try {
    for (const file of MIGRATION_FILES) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      // makeIdempotent rewrites the bare `CREATE ROLE app_rls` line (0000 only)
      // and the app_webhook CREATE/ALTER password literals (0002 only).
      // For files that lack these lines it is a no-op (regexes find nothing).
      const idempotent = makeIdempotent(raw, appRlsPassword, appWebhookPassword);
      await adminSql.unsafe(idempotent);
      console.info(`[migrate] applied ${file}`);
    }
    console.info('[migrate] all migrations applied successfully');
  } finally {
    await adminSql.end();
  }
}

// ---------------------------------------------------------------------------
// Standalone script entrypoint
// ---------------------------------------------------------------------------

// When this module is the entry point (not imported), run the migration.
// Detects via import.meta.url vs process.argv[1].
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url)
    .replace(/\\/g, '/')
    .endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const { loadEnv } = await import('../config/env.js');
  const env = loadEnv();
  await runMigration(env);
  process.exit(0);
}
