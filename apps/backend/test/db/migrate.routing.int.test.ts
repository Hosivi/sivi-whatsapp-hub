/**
 * migrate.routing.int.test.ts — Proves 0001_routing.sql is correctly applied.
 *
 * After applying ['0000_contacts.sql', '0001_routing.sql']:
 * - contact_lead_outbox exists with all 6 columns
 * - RLS is ENABLED + FORCED on contact_lead_outbox
 * - app_rls has SELECT + INSERT grants on contact_lead_outbox
 * - contacts.routed_at column exists
 *
 * Run order:
 *   0000 first (creates role + base grants), 0001 second (grants on outbox).
 *   Raw SQL is executed as superuser — no makeIdempotent needed (0001 has no role line).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeIdempotent } from '../../src/db/migrate.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../drizzle');
const MIGRATION_FILES = ['0000_contacts.sql', '0001_routing.sql'] as const;
const APP_RLS_PASSWORD = 'testpassword';

describe('migration 0001_routing — schema verification', () => {
  let container: StartedPostgreSqlContainer;
  let adminSql: postgres.Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('testdb')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    adminSql = postgres(container.getConnectionUri(), { max: 2 });

    // Apply both migrations in order
    for (const file of MIGRATION_FILES) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      // makeIdempotent is a no-op for 0001 (no CREATE ROLE line) — safe to apply to both.
      const sql = makeIdempotent(raw, APP_RLS_PASSWORD);
      await adminSql.unsafe(sql);
    }
  });

  afterAll(async () => {
    await adminSql?.end();
    await container?.stop();
  });

  it('contacts.routed_at column exists', async () => {
    const [row] = await adminSql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'contacts' AND column_name = 'routed_at'
    `;
    expect(row).toBeDefined();
    expect(row?.column_name).toBe('routed_at');
    expect(row?.is_nullable).toBe('YES');
  });

  it('contact_lead_outbox table exists with all 6 columns', async () => {
    const rows = await adminSql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'contact_lead_outbox'
      ORDER BY ordinal_position
    `;
    const names = rows.map((r) => r.column_name as string);
    expect(names).toContain('id');
    expect(names).toContain('tenant_id');
    expect(names).toContain('contact_id');
    expect(names).toContain('payload');
    expect(names).toContain('status');
    expect(names).toContain('created_at');
    expect(names).toHaveLength(6);
  });

  it('contact_lead_outbox has RLS ENABLED and FORCED', async () => {
    const [row] = await adminSql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = 'contact_lead_outbox'
    `;
    expect(row).toBeDefined();
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);
  });

  it('tenant_isolation policy exists on contact_lead_outbox', async () => {
    const [policy] = await adminSql`
      SELECT polname FROM pg_policy
      WHERE polrelid = 'contact_lead_outbox'::regclass AND polname = 'tenant_isolation'
    `;
    expect(policy).toBeDefined();
  });

  it('app_rls has SELECT and INSERT grants on contact_lead_outbox', async () => {
    const rows = await adminSql`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'contact_lead_outbox'
        AND grantee = 'app_rls'
        AND privilege_type IN ('SELECT', 'INSERT')
    `;
    const types = rows.map((r) => r.privilege_type as string);
    expect(types).toContain('SELECT');
    expect(types).toContain('INSERT');
  });

  it('both migrations are idempotent — second run does not throw', async () => {
    for (const file of MIGRATION_FILES) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      const sql = makeIdempotent(raw, APP_RLS_PASSWORD);
      await expect(adminSql.unsafe(sql)).resolves.toBeDefined();
    }
  });
});
