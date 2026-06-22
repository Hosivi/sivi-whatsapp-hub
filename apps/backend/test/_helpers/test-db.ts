/**
 * test-db.ts — Testcontainers helper for integration tests.
 *
 * createTestDb():
 * 1. Starts a postgres:16-alpine container.
 * 2. Connects as the container superuser and runs drizzle/0000_contacts.sql
 *    (creates table, RLS policy, app_rls role, grants).
 * 3. Returns a TestDb handle with:
 *    - withTenant: a TenantRunner connected AS app_rls (RLS enforced).
 *    - adminQuery: direct Drizzle handle connected as superuser (bypasses RLS
 *      — use only for test setup/assertions, never in production code).
 *    - appRlsConnectionString: the raw connection string for direct postgres.js
 *      clients in tests that need to verify no-SET-LOCAL behavior.
 *    - seedTenant: convenience helper to insert a contact row for a given tenant.
 *    - truncate: removes all rows from contacts (between tests).
 *    - teardown: stops the container and closes all connections.
 *
 * IMPORTANT — password literal:
 *   The SQL in 0000_contacts.sql uses a LITERAL password string ('testpassword')
 *   for CREATE ROLE app_rls. Do NOT use psql variable syntax (:'app_rls_pw') —
 *   the postgres.js driver is not the psql CLI and does not expand those variables.
 *
 * IMPORTANT — app.current_tenant GUC:
 *   Postgres requires SET LOCAL on a custom GUC to work without error. The USING
 *   clause in the RLS policy references current_setting('app.current_tenant') which
 *   will throw "unrecognized configuration parameter" on a fresh connection if the
 *   GUC has never been SET in that session. The RLS policy uses current_setting()
 *   with a default (via the 2-arg form in Postgres 9.6+) to avoid the error.
 *   In practice, withTenant always calls set_config() before any query, so the
 *   GUC is always defined within the transaction boundary.
 *   The policy uses NULLIF(current_setting('app.current_tenant', true), '')::uuid
 *   which converts missing/empty to NULL, so a query without SET LOCAL returns 0 rows
 *   instead of raising an error. This is the "default-deny" behavior tested in test (e).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql as rawSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { TenantRunner } from '../../src/db/client.js';
import { contactsTable } from '../../src/db/schema/contacts.schema.js';

// ---------------------------------------------------------------------------
// Path to the migration SQL file
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATION_SQL_PATH = join(__dirname, '../../drizzle/0000_contacts.sql');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TestDb = {
  /** TenantRunner connected AS app_rls — RLS is enforced. */
  readonly withTenant: TenantRunner;
  /** Drizzle handle connected as superuser — bypasses RLS. Use for test setup only. */
  readonly adminQuery: <T>(run: (tx: PostgresJsDatabase) => Promise<T>) => Promise<T>;
  /** Raw app_rls connection string (for direct-client tests). */
  readonly appRlsConnectionString: string;
  /** Insert a contact row for the given tenant directly (bypasses RLS via adminSql). */
  seedTenant(tenantId: string, data: { phoneE164: string; fullName?: string }): Promise<void>;
  /** Truncate the contacts table (admin bypasses RLS). */
  truncate(): Promise<void>;
  /** Stop the container and close all connections. */
  teardown(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createTestDb(): Promise<TestDb> {
  // 1. Start the container
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('testdb')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  // 2. Build admin (superuser) connection string from container
  const adminConnectionString = container.getConnectionUri();

  // 3. Connect as superuser and run the migration
  const adminSql = postgres(adminConnectionString, { max: 2 });
  const adminDb = drizzle(adminSql);

  // Read and run the migration SQL.
  // The migration includes: table DDL, indexes, RLS (with missing_ok=true),
  // CREATE ROLE app_rls (with LITERAL password 'testpassword'), and GRANTs.
  const migrationSql = readFileSync(MIGRATION_SQL_PATH, 'utf-8');

  // Run migration — use unsafe() for multi-statement DDL
  await adminSql.unsafe(migrationSql);

  // 4. Build app_rls connection string (same host/port/db, different role)
  const { hostname, port, pathname } = new URL(adminConnectionString);
  const appRlsConnectionString = `postgresql://app_rls:testpassword@${hostname}:${port}${pathname}`;

  // 5. Create app_rls-scoped postgres.js connection + Drizzle wrapper
  const appRlsSql = postgres(appRlsConnectionString, { max: 5 });
  const appRlsDb = drizzle(appRlsSql);

  // 6. Build the TenantRunner using Drizzle transactions (matches createDbClient pattern)
  const withTenant: TenantRunner = (tenantId, run) =>
    appRlsDb.transaction(async (tx) => {
      await tx.execute(rawSql`SELECT set_config('app.current_tenant', ${tenantId}, true)`);
      return run(tx);
    });

  // 7. Admin query helper for test setup/assertions (bypasses RLS)
  const adminQuery = <T>(run: (tx: PostgresJsDatabase) => Promise<T>): Promise<T> => run(adminDb);

  return {
    withTenant,
    adminQuery,
    appRlsConnectionString,

    async seedTenant(tenantId, data) {
      // Insert directly via admin connection (bypasses RLS) so we can seed both tenants.
      await adminDb.insert(contactsTable).values({
        tenantId,
        phoneE164: data.phoneE164,
        fullName: data.fullName ?? null,
      });
    },

    async truncate() {
      // Truncate via admin (superuser) bypasses RLS.
      await adminSql`TRUNCATE TABLE contacts RESTART IDENTITY CASCADE`;
    },

    async teardown() {
      await appRlsSql.end();
      await adminSql.end();
      await container.stop();
    },
  };
}
