/**
 * migrate.ai-reply-usage.int.test.ts — Proves 0009_ai_reply_usage.sql is registered
 * in the production runner, applies on a fresh database, and re-runs idempotently.
 *
 * Applies EVERY file of the runner's MIGRATION_FILES list (through makeIdempotent,
 * exactly as runMigration does) twice on a fresh postgres:16 container, then checks:
 * - ai_reply_usage columns, types, nullability and defaults
 * - status / outbound_wamid CHECK constraints
 * - (tenant_id, outbound_wamid) index
 * - RLS ENABLED + FORCED, tenant_isolation policy TO app_rls
 * - least-privilege grants: app_rls SELECT + INSERT only; app_webhook nothing
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_FILES, makeIdempotent } from '../../src/db/migrate.js';

const MIGRATIONS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../drizzle');
const PASSWORD = 'testpassword';

describe('migration 0009_ai_reply_usage', () => {
  let container: StartedPostgreSqlContainer;
  let adminSql: postgres.Sql;

  const applyAll = async (): Promise<void> => {
    for (const file of MIGRATION_FILES) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      await adminSql.unsafe(makeIdempotent(raw, PASSWORD, PASSWORD));
    }
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('testdb')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    adminSql = postgres(container.getConnectionUri(), { max: 2 });
    await applyAll();
  });

  afterAll(async () => {
    await adminSql?.end();
    await container?.stop();
  });

  it('is registered in the runner, after 0004', () => {
    expect(MIGRATION_FILES).toContain('0009_ai_reply_usage.sql');
    expect(MIGRATION_FILES.indexOf('0009_ai_reply_usage.sql')).toBeGreaterThan(
      MIGRATION_FILES.indexOf('0004_tenant_ai_config.sql'),
    );
  });

  it('creates ai_reply_usage with the expected columns, types and nullability', async () => {
    const rows = await adminSql<
      Array<{ column_name: string; data_type: string; is_nullable: string }>
    >`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'ai_reply_usage'
      ORDER BY ordinal_position
    `;
    const columns = Object.fromEntries(
      rows.map((r) => [r.column_name, `${r.data_type}${r.is_nullable === 'YES' ? '?' : ''}`]),
    );
    expect(columns).toEqual({
      id: 'uuid',
      tenant_id: 'uuid',
      contact_id: 'uuid?',
      inbound_wamid: 'text?',
      outbound_wamid: 'text?',
      status: 'text',
      provider: 'text',
      model: 'text',
      input_tokens: 'integer',
      output_tokens: 'integer',
      reasoning_tokens: 'integer?',
      cached_input_tokens: 'integer?',
      total_tokens: 'integer',
      llm_calls: 'integer',
      tool_calls: 'ARRAY',
      fallback_attempts: 'jsonb',
      latency_ms: 'integer',
      created_at: 'timestamp with time zone',
      deleted_at: 'timestamp with time zone?',
    });
  });

  it('CHECK constraints: status ∈ {sent, send_failed}; sent ⇔ outbound_wamid present', async () => {
    const tenant = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const insert = (status: string, outboundWamid: string | null) => adminSql`
      INSERT INTO ai_reply_usage
        (tenant_id, outbound_wamid, status, provider, model, input_tokens, output_tokens,
         total_tokens, llm_calls, latency_ms)
      VALUES (${tenant}::uuid, ${outboundWamid}, ${status}, 'gemini', 'm', 1, 1, 2, 1, 1)
    `;
    await expect(insert('bogus', null)).rejects.toThrow(/check constraint/);
    await expect(insert('sent', null)).rejects.toThrow(/check constraint/);
    await expect(insert('send_failed', 'wamid-x')).rejects.toThrow(/check constraint/);
    await expect(insert('sent', 'wamid-ok')).resolves.toBeDefined();
    await expect(insert('send_failed', null)).resolves.toBeDefined();
    const [row] = await adminSql<Array<{ tool_calls: string[]; fallback_attempts: unknown }>>`
      SELECT tool_calls, fallback_attempts FROM ai_reply_usage WHERE outbound_wamid = 'wamid-ok'
    `;
    expect(row).toEqual({ tool_calls: [], fallback_attempts: [] });
    await adminSql`DELETE FROM ai_reply_usage`;
  });

  it('indexes (tenant_id, outbound_wamid)', async () => {
    const [index] = await adminSql<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'ai_reply_usage' AND indexname = 'ai_reply_usage_tenant_outbound_wamid_idx'
    `;
    expect(index?.indexdef).toMatch(/\(tenant_id, outbound_wamid\)/);
  });

  it('RLS is ENABLED and FORCED, with a tenant_isolation policy TO app_rls', async () => {
    const [table] = await adminSql<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ai_reply_usage'
    `;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const [policy] = await adminSql<Array<{ roles: string[]; qual: string; with_check: string }>>`
      SELECT roles, qual, with_check FROM pg_policies
      WHERE tablename = 'ai_reply_usage' AND policyname = 'tenant_isolation'
    `;
    expect(policy?.roles).toEqual(['app_rls']);
    expect(policy?.qual).toMatch(/app\.current_tenant/);
    expect(policy?.with_check).toMatch(/app\.current_tenant/);
  });

  it('grants app_rls SELECT + INSERT only, and app_webhook nothing', async () => {
    const grants = await adminSql<Array<{ grantee: string; privilege_type: string }>>`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'ai_reply_usage' AND grantee IN ('app_rls', 'app_webhook')
      ORDER BY grantee, privilege_type
    `;
    expect(grants).toEqual([
      { grantee: 'app_rls', privilege_type: 'INSERT' },
      { grantee: 'app_rls', privilege_type: 'SELECT' },
    ]);
  });

  it('re-running every registered migration is idempotent', async () => {
    await expect(applyAll()).resolves.toBeUndefined();
    const [count] = await adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'ai_reply_usage'
    `;
    expect(count?.n).toBe(1);
  });
});
