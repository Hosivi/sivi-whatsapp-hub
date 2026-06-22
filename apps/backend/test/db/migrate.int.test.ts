/**
 * migrate.int.test.ts — Proves the production migration is idempotent (safe to re-run).
 *
 * The production runner (src/db/migrate.ts) applies makeIdempotent() to
 * drizzle/0000_contacts.sql and executes it via adminSql.unsafe(). This test runs
 * that exact transformed SQL TWICE against a fresh container and asserts the second
 * run does not throw — covering the re-run path the rest of the suite never exercises
 * (createTestDb runs the migration exactly once on a fresh container).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeIdempotent } from '../../src/db/migrate.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATION_SQL_PATH = join(__dirname, '../../drizzle/0000_contacts.sql');
const APP_RLS_PASSWORD = 'testpassword';

describe('migration idempotency', () => {
  let container: StartedPostgreSqlContainer;
  let adminSql: postgres.Sql;
  let migrationSql: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('testdb')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    adminSql = postgres(container.getConnectionUri(), { max: 2 });
    migrationSql = makeIdempotent(readFileSync(MIGRATION_SQL_PATH, 'utf-8'), APP_RLS_PASSWORD);
  });

  afterAll(async () => {
    await adminSql?.end();
    await container?.stop();
  });

  it('applies cleanly on the first run', async () => {
    await expect(adminSql.unsafe(migrationSql)).resolves.toBeDefined();
  });

  it('is idempotent — a second run does not throw', async () => {
    await expect(adminSql.unsafe(migrationSql)).resolves.toBeDefined();
  });

  it('leaves the constraint, policy, and non-superuser app_rls role in place', async () => {
    const [constraint] =
      await adminSql`SELECT 1 FROM pg_constraint WHERE conname = 'intent_confidence_range'`;
    const [policy] = await adminSql`SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation'`;
    const [role] =
      await adminSql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_rls'`;

    expect(constraint).toBeDefined();
    expect(policy).toBeDefined();
    expect(role).toBeDefined();
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
  });
});
