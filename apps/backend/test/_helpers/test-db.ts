/**
 * test-db.ts — Testcontainers helper for integration tests.
 *
 * createTestDb():
 * 1. Starts a postgres:16-alpine container.
 * 2. Connects as the container superuser and runs all migration files
 *    (creates tables, RLS policies, roles, grants).
 * 3. Returns a TestDb handle with:
 *    - withTenant: a TenantRunner connected AS app_rls (RLS enforced).
 *    - adminQuery: direct Drizzle handle connected as superuser (bypasses RLS
 *      — use only for test setup/assertions, never in production code).
 *    - appRlsConnectionString: the raw connection string for direct postgres.js
 *      clients in tests that need to verify no-SET-LOCAL behavior.
 *    - seedTenant: convenience helper to insert a contact row for a given tenant.
 *    - seedWhatsappAccount: inserts a whatsapp_accounts row for test setup.
 *    - resolveWebhookTenant: exercises the app_webhook connection (resolveTenant).
 *    - truncate: removes all rows from all domain tables (between tests).
 *    - teardown: stops the container and closes all connections.
 *
 * IMPORTANT — password literal:
 *   The SQL in 0000_contacts.sql uses a LITERAL password string ('testpassword')
 *   for CREATE ROLE app_rls. The SQL in 0002_whatsapp.sql uses the same literal
 *   for CREATE ROLE app_webhook. Do NOT use psql variable syntax (:'pw') —
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
import { eq } from 'drizzle-orm';
import { sql as rawSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { TenantRunner, WebhookLookupError } from '../../src/db/client.js';
import { contactsTable } from '../../src/db/schema/contacts.schema.js';
import { whatsappAccountsTable } from '../../src/db/schema/whatsapp-accounts.schema.js';
import type { Result } from '../../src/shared/result.js';
import { err, ok } from '../../src/shared/result.js';

// ---------------------------------------------------------------------------
// Migration files — applied in order on the fresh container
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../drizzle');
const MIGRATION_FILES = ['0000_contacts.sql', '0001_routing.sql', '0002_whatsapp.sql', '0003_outbound.sql'] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TestDb = {
  /** TenantRunner connected AS app_rls — RLS is enforced. */
  readonly withTenant: TenantRunner;
  /** Drizzle handle connected as superuser — bypasses RLS. Use for test setup only. */
  readonly adminQuery: <T>(run: (tx: PostgresJsDatabase) => Promise<T>) => Promise<T>;
  /** Raw postgres.js superuser handle — use for seed-dev tests and schema bootstrapping only. */
  readonly adminSql: postgres.Sql;
  /** Raw app_rls connection string (for direct-client tests). */
  readonly appRlsConnectionString: string;
  /**
   * Resolves tenant_id from phone_number_id using the app_webhook connection (low-priv).
   * Satisfies the DbClient.resolveTenant contract so TestDb can be passed to buildApp().
   */
  resolveTenant(phoneNumberId: string): Promise<Result<string, WebhookLookupError>>;
  /** Resolve a tenant from phone_number_id using the app_webhook connection (low-priv). */
  resolveWebhookTenant(phoneNumberId: string): Promise<Result<string, WebhookLookupError>>;
  /** Insert a contact row for the given tenant directly (bypasses RLS via adminSql). */
  seedTenant(
    tenantId: string,
    data: { phoneE164: string; fullName?: string | null; routedAt?: Date | null },
  ): Promise<void>;
  /** Insert a whatsapp_accounts row directly (bypasses RLS via adminSql). */
  seedWhatsappAccount(data: {
    phoneNumberId: string;
    tenantId: string;
    displayPhoneNumber: string;
    wabaId: string;
  }): Promise<void>;
  /** Truncate all domain tables (admin bypasses RLS). */
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

  // Apply migrations in order: 0000 first (creates role + base grants),
  // 0001 second (adds routed_at + outbox table + outbox grants).
  // Raw SQL executed as superuser — no makeIdempotent needed (0001 has no role line;
  // 0000 uses a LITERAL 'testpassword' which is correct for the test path).
  for (const file of MIGRATION_FILES) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    await adminSql.unsafe(sqlText);
  }

  // 4. Build connection strings (same host/port/db, different roles)
  const { hostname, port, pathname } = new URL(adminConnectionString);
  const appRlsConnectionString = `postgresql://app_rls:testpassword@${hostname}:${port}${pathname}`;
  const appWebhookConnectionString = `postgresql://app_webhook:testpassword@${hostname}:${port}${pathname}`;

  // 5. Create app_rls-scoped postgres.js connection + Drizzle wrapper
  const appRlsSql = postgres(appRlsConnectionString, { max: 5 });
  const appRlsDb = drizzle(appRlsSql);

  // 6. Create app_webhook-scoped postgres.js connection + Drizzle wrapper (low-privilege lookup)
  const appWebhookSql = postgres(appWebhookConnectionString, { max: 2 });
  const appWebhookDb = drizzle(appWebhookSql);

  // 7. Build the TenantRunner using Drizzle transactions (matches createDbClient pattern)
  const withTenant: TenantRunner = (tenantId, run) =>
    appRlsDb.transaction(async (tx) => {
      await tx.execute(rawSql`SELECT set_config('app.current_tenant', ${tenantId}, true)`);
      return run(tx);
    });

  // 8. Admin query helper for test setup/assertions (bypasses RLS)
  const adminQuery = <T>(run: (tx: PostgresJsDatabase) => Promise<T>): Promise<T> => run(adminDb);

  return {
    withTenant,
    adminQuery,
    adminSql,
    appRlsConnectionString,

    async seedTenant(tenantId, data) {
      // Insert directly via admin connection (bypasses RLS) so we can seed both tenants.
      await adminDb.insert(contactsTable).values({
        tenantId,
        phoneE164: data.phoneE164,
        fullName: data.fullName ?? null,
        ...(data.routedAt !== undefined ? { routedAt: data.routedAt } : {}),
      });
    },

    async seedWhatsappAccount({ phoneNumberId, tenantId, displayPhoneNumber, wabaId }) {
      // Insert directly via admin connection (bypasses RLS).
      await adminDb.insert(whatsappAccountsTable).values({
        tenantId,
        phoneNumberId,
        displayPhoneNumber,
        wabaId,
      });
    },

    async resolveTenant(phoneNumberId: string): Promise<Result<string, WebhookLookupError>> {
      // Implements the DbClient.resolveTenant contract using the app_webhook connection.
      // SELECT only the granted columns — never SELECT *.
      const rows = await appWebhookDb
        .select({
          phoneNumberId: whatsappAccountsTable.phoneNumberId,
          tenantId: whatsappAccountsTable.tenantId,
        })
        .from(whatsappAccountsTable)
        .where(eq(whatsappAccountsTable.phoneNumberId, phoneNumberId))
        .limit(1);

      const row = rows[0] ?? null;
      if (!row) {
        return err({ code: 'UNKNOWN_PHONE_NUMBER_ID' });
      }
      return ok(row.tenantId);
    },

    async resolveWebhookTenant(phoneNumberId: string): Promise<Result<string, WebhookLookupError>> {
      // Alias for resolveTenant — kept for backward compat with existing tests
      // (e.g. client.int.test.ts uses resolveWebhookTenant directly).
      const rows = await appWebhookDb
        .select({
          phoneNumberId: whatsappAccountsTable.phoneNumberId,
          tenantId: whatsappAccountsTable.tenantId,
        })
        .from(whatsappAccountsTable)
        .where(eq(whatsappAccountsTable.phoneNumberId, phoneNumberId))
        .limit(1);

      const row = rows[0] ?? null;
      if (!row) {
        return err({ code: 'UNKNOWN_PHONE_NUMBER_ID' });
      }
      return ok(row.tenantId);
    },

    async truncate() {
      // Truncate all domain tables via admin (superuser) bypasses RLS.
      // Order: whatsapp_messages first (FK → contacts), then whatsapp_accounts, outbox, contacts.
      await adminSql`TRUNCATE TABLE whatsapp_messages, whatsapp_accounts, contact_lead_outbox, contacts RESTART IDENTITY CASCADE`;
    },

    async teardown() {
      await appRlsSql.end();
      await appWebhookSql.end();
      await adminSql.end();
      await container.stop();
    },
  };
}
