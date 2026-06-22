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
const MIGRATION_SQL_PATH = join(__dirname, '../../drizzle/0000_contacts.sql');

/**
 * Replaces the bare CREATE ROLE line with an idempotent DO block.
 * The password is supplied by the caller (from APP_RLS_PASSWORD) — never a source
 * literal — and MUST match the app_rls password embedded in DATABASE_URL. On a
 * re-run the role already exists, so we ALTER its password to keep it in sync.
 */
export function makeIdempotent(sql: string, appRlsPassword: string): string {
  const safePw = appRlsPassword.replace(/'/g, "''");
  // A replacement FUNCTION is required here: a replacement STRING would treat the
  // `$$` dollar-quote delimiters as `$`-escapes (`$$` -> `$`) and corrupt the DO block.
  return sql.replace(
    /CREATE ROLE app_rls[^\n;]+;/,
    () => `DO $$
BEGIN
  CREATE ROLE app_rls LOGIN PASSWORD '${safePw}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE app_rls LOGIN PASSWORD '${safePw}';
END
$$;`,
  );
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
  const adminSql = postgres(env.DATABASE_ADMIN_URL, { max: 1 });

  try {
    const raw = readFileSync(MIGRATION_SQL_PATH, 'utf-8');
    const idempotent = makeIdempotent(raw, appRlsPassword);
    await adminSql.unsafe(idempotent);
    console.info('[migrate] migration applied successfully');
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
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const { loadEnv } = await import('../config/env.js');
  const env = loadEnv();
  await runMigration(env);
  process.exit(0);
}
