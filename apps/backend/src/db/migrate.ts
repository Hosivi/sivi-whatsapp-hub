/**
 * migrate.ts — Idempotent migration runner.
 *
 * Reads drizzle/0000_contacts.sql and executes it via the privileged adminSql
 * connection. Safe to re-run: the SQL uses CREATE TABLE IF NOT EXISTS, CREATE
 * INDEX IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS. RLS commands are
 * idempotent (ALTER TABLE ... ENABLE / FORCE are no-ops if already set).
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
 * Wraps CREATE ROLE to be idempotent via PL/pgSQL exception handling.
 * The raw SQL uses psql variable syntax (:'app_rls_pw') which the postgres.js
 * driver cannot expand — we replace the CREATE ROLE line with an idempotent block.
 */
function makeIdempotent(sql: string): string {
  // Replace the bare CREATE ROLE line with a DO block that ignores duplicate_object.
  return sql.replace(
    /CREATE ROLE app_rls[^\n;]+;/,
    `DO $$
BEGIN
  CREATE ROLE app_rls LOGIN PASSWORD 'app_rls_production' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  NULL;
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
  const adminSql = postgres(env.DATABASE_ADMIN_URL, { max: 1 });

  try {
    const raw = readFileSync(MIGRATION_SQL_PATH, 'utf-8');
    const idempotent = makeIdempotent(raw);
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
