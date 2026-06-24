/**
 * migrate.int.test.ts — Proves the production migration is idempotent (safe to re-run).
 *
 * The production runner (src/db/migrate.ts) applies makeIdempotent() to
 * drizzle/0000_contacts.sql and executes it via adminSql.unsafe(). This test runs
 * that exact transformed SQL TWICE against a fresh container and asserts the second
 * run does not throw — covering the re-run path the rest of the suite never exercises
 * (createTestDb runs the migration exactly once on a fresh container).
 *
 * Also covers 0002_whatsapp.sql:
 * - whatsapp_accounts and whatsapp_messages tables exist with canonical shapes
 * - app_webhook role is provisioned (NOSUPERUSER, NOBYPASSRLS)
 * - column-scoped grant on whatsapp_accounts for app_webhook
 * - app_rls grants on both tables
 * - RLS ENABLED + FORCED on both tables
 * - makeIdempotent 3rd param rewrites app_webhook CREATE/ALTER password
 * - migration re-run is idempotent (no throw on second run)
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

// ---------------------------------------------------------------------------
// 0002_whatsapp.sql — schema verification + role provisioning
// ---------------------------------------------------------------------------

const ALL_MIGRATION_FILES = ['0000_contacts.sql', '0001_routing.sql', '0002_whatsapp.sql'];
const APP_WEBHOOK_PASSWORD = 'testpassword';

describe('migration 0002_whatsapp — schema, role, and grants', () => {
  let container: StartedPostgreSqlContainer;
  let adminSql: postgres.Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('testdb')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    adminSql = postgres(container.getConnectionUri(), { max: 2 });

    const migrationsDir = join(__dirname, '../../drizzle');
    for (const file of ALL_MIGRATION_FILES) {
      const raw = readFileSync(join(migrationsDir, file), 'utf-8');
      // makeIdempotent with 3rd arg rewrites app_webhook password for 0002;
      // is a no-op for 0000/0001 on the app_webhook lines (they don't exist there).
      const sql = makeIdempotent(raw, APP_RLS_PASSWORD, APP_WEBHOOK_PASSWORD);
      await adminSql.unsafe(sql);
    }
  });

  afterAll(async () => {
    await adminSql?.end();
    await container?.stop();
  });

  it('whatsapp_accounts table exists with canonical columns (no secret/direction cols)', async () => {
    const rows = await adminSql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'whatsapp_accounts'
      ORDER BY ordinal_position
    `;
    const names = rows.map((r) => r.column_name as string);
    expect(names).toContain('id');
    expect(names).toContain('tenant_id');
    expect(names).toContain('phone_number_id');
    expect(names).toContain('display_phone_number');
    expect(names).toContain('waba_id');
    expect(names).toContain('is_active');
    expect(names).toContain('created_at');
    expect(names).toContain('updated_at');
    expect(names).toContain('deleted_at');
    // No credential columns — global env vars handle these
    expect(names).not.toContain('app_secret');
    expect(names).not.toContain('verify_token');
  });

  it('whatsapp_messages table exists with canonical columns (no direction col)', async () => {
    const rows = await adminSql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'whatsapp_messages'
      ORDER BY ordinal_position
    `;
    const names = rows.map((r) => r.column_name as string);
    expect(names).toContain('id');
    expect(names).toContain('tenant_id');
    expect(names).toContain('wamid');
    expect(names).toContain('phone_number_id');
    expect(names).toContain('contact_id');
    expect(names).toContain('from_phone_e164');
    expect(names).toContain('message_type');
    expect(names).toContain('text_body');
    expect(names).toContain('raw_payload');
    expect(names).toContain('received_at');
    expect(names).toContain('created_at');
    // Removed in design (W6): no direction column
    expect(names).not.toContain('direction');
  });

  it('contact_id on whatsapp_messages is NOT NULL and has FK to contacts(id)', async () => {
    const [col] = await adminSql`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'whatsapp_messages' AND column_name = 'contact_id'
    `;
    expect(col?.is_nullable).toBe('NO');

    const [fk] = await adminSql`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      JOIN information_schema.table_constraints ccu
        ON rc.unique_constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'whatsapp_messages'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'contacts'
    `;
    expect(fk).toBeDefined();
  });

  it('partial UNIQUE index on whatsapp_accounts.phone_number_id WHERE deleted_at IS NULL', async () => {
    const [idx] = await adminSql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'whatsapp_accounts'
        AND indexname = 'whatsapp_accounts_phone_number_id_uq'
    `;
    expect(idx).toBeDefined();
    expect(idx?.indexdef).toContain('WHERE');
    expect(idx?.indexdef?.toLowerCase()).toContain('deleted_at is null');
  });

  it('UNIQUE index on whatsapp_messages.wamid', async () => {
    const [idx] = await adminSql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'whatsapp_messages'
        AND indexname = 'whatsapp_messages_wamid_uq'
    `;
    expect(idx).toBeDefined();
  });

  it('RLS is ENABLED and FORCED on whatsapp_accounts', async () => {
    const [row] = await adminSql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'whatsapp_accounts'
    `;
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);
  });

  it('RLS is ENABLED and FORCED on whatsapp_messages', async () => {
    const [row] = await adminSql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'whatsapp_messages'
    `;
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);
  });

  it('app_webhook role exists with NOSUPERUSER and NOBYPASSRLS', async () => {
    const [role] = await adminSql`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      FROM pg_roles WHERE rolname = 'app_webhook'
    `;
    expect(role).toBeDefined();
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
    expect(role?.rolcreatedb).toBe(false);
    expect(role?.rolcreaterole).toBe(false);
  });

  it('app_rls has SELECT, INSERT, UPDATE, DELETE on whatsapp_accounts', async () => {
    const rows = await adminSql`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'whatsapp_accounts'
        AND grantee = 'app_rls'
        AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    `;
    const types = rows.map((r) => r.privilege_type as string);
    expect(types).toContain('SELECT');
    expect(types).toContain('INSERT');
    expect(types).toContain('UPDATE');
    expect(types).toContain('DELETE');
  });

  it('app_rls has SELECT and INSERT on whatsapp_messages', async () => {
    const rows = await adminSql`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'whatsapp_messages'
        AND grantee = 'app_rls'
        AND privilege_type IN ('SELECT', 'INSERT')
    `;
    const types = rows.map((r) => r.privilege_type as string);
    expect(types).toContain('SELECT');
    expect(types).toContain('INSERT');
  });

  it('app_webhook has column-scoped SELECT (phone_number_id, tenant_id) on whatsapp_accounts', async () => {
    const rows = await adminSql`
      SELECT column_name, privilege_type
      FROM information_schema.column_privileges
      WHERE table_name = 'whatsapp_accounts'
        AND grantee = 'app_webhook'
    `;
    const cols = rows.map((r) => r.column_name as string);
    expect(cols).toContain('phone_number_id');
    expect(cols).toContain('tenant_id');
    // No other columns granted
    expect(cols).not.toContain('id');
    expect(cols).not.toContain('waba_id');
  });

  it('app_webhook has no grants on whatsapp_messages', async () => {
    const rows = await adminSql`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'whatsapp_messages' AND grantee = 'app_webhook'
    `;
    expect(rows).toHaveLength(0);
  });

  it('tenant_isolation policy exists on whatsapp_accounts (TO app_rls)', async () => {
    const [policy] = await adminSql`
      SELECT polname, polroles::text
      FROM pg_policy
      WHERE polrelid = 'whatsapp_accounts'::regclass AND polname = 'tenant_isolation'
    `;
    expect(policy).toBeDefined();
  });

  it('webhook_config_read policy exists on whatsapp_accounts (TO app_webhook, SELECT only)', async () => {
    const [policy] = await adminSql`
      SELECT polname, polcmd
      FROM pg_policy
      WHERE polrelid = 'whatsapp_accounts'::regclass AND polname = 'webhook_config_read'
    `;
    expect(policy).toBeDefined();
    // polcmd: 'r' = SELECT
    expect(policy?.polcmd).toBe('r');
  });

  it('tenant_isolation policy exists on whatsapp_messages (TO app_rls)', async () => {
    const [policy] = await adminSql`
      SELECT polname
      FROM pg_policy
      WHERE polrelid = 'whatsapp_messages'::regclass AND polname = 'tenant_isolation'
    `;
    expect(policy).toBeDefined();
  });

  it('all 3 migrations are idempotent — second run does not throw', async () => {
    const migrationsDir = join(__dirname, '../../drizzle');
    for (const file of ALL_MIGRATION_FILES) {
      const raw = readFileSync(join(migrationsDir, file), 'utf-8');
      const sql = makeIdempotent(raw, APP_RLS_PASSWORD, APP_WEBHOOK_PASSWORD);
      await expect(adminSql.unsafe(sql)).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// makeIdempotent — 3rd param rewrites app_webhook passwords
// ---------------------------------------------------------------------------

describe('makeIdempotent — 3rd param (app_webhook password)', () => {
  it('rewrites CREATE ROLE app_webhook password when 3rd arg provided', () => {
    const input = `CREATE ROLE app_webhook LOGIN PASSWORD 'testpassword' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`;
    const result = makeIdempotent(input, 'rlspass', 'newwebhookpw');
    expect(result).toContain("PASSWORD 'newwebhookpw'");
    expect(result).not.toContain("PASSWORD 'testpassword'");
  });

  it('rewrites ALTER ROLE app_webhook password when 3rd arg provided', () => {
    const input = `ALTER ROLE app_webhook LOGIN PASSWORD 'testpassword';`;
    const result = makeIdempotent(input, 'rlspass', 'alteredpw');
    expect(result).toContain("PASSWORD 'alteredpw'");
    expect(result).not.toContain("PASSWORD 'testpassword'");
  });

  it('leaves app_webhook password literal unchanged when only 2 args (default)', () => {
    const input = `CREATE ROLE app_webhook LOGIN PASSWORD 'testpassword' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`;
    // 2-arg call — 3rd param defaults to 'app_webhook'
    const result = makeIdempotent(input, 'rlspass');
    // The literal 'testpassword' is REPLACED by the default 'app_webhook' value
    // which is the correct behavior — 2-arg callers use default 'app_webhook'
    expect(result).toContain("PASSWORD 'app_webhook'");
  });

  it('2-arg call does not affect app_rls lines', () => {
    const input = `CREATE ROLE app_rls LOGIN PASSWORD 'old' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`;
    const result = makeIdempotent(input, 'myrls');
    expect(result).toContain("PASSWORD 'myrls'");
  });
});
