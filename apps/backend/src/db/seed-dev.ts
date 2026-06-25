/**
 * seed-dev.ts — Idempotent dev seed.
 *
 * Inserts a fixed dev tenant row into whatsapp_accounts so the inbound webhook
 * can resolve the tenant during local development. Safe to run multiple times:
 * uses INSERT ... ON CONFLICT DO NOTHING so repeated runs are no-ops.
 *
 * Exports DEV_TENANT_ID and DEV_PHONE_NUMBER_ID for use by integration tests
 * and the web dev console (via NEXT_PUBLIC_DEFAULT_TENANT_ID).
 *
 * Usage (as a standalone script):
 *   pnpm --filter @sivihub/whatsapp-hub-backend seed:dev
 *
 * For tests: import runDevSeed and pass an adminSql connection obtained from
 * the test DB helper. This avoids starting a real server for test setup.
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Dev seed constants — export for use by tests and apps/web env config
// ---------------------------------------------------------------------------

/** Fixed dev tenant UUID. Must match NEXT_PUBLIC_DEFAULT_TENANT_ID in apps/web/.env.local */
export const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000001' as const;

/** Fixed dev phone number ID (Meta's phone_number_id for the dev seed account). */
export const DEV_PHONE_NUMBER_ID = 'dev-phone-123' as const;

// ---------------------------------------------------------------------------
// Seed function
// ---------------------------------------------------------------------------

/**
 * Idempotent dev seed: inserts exactly one row into whatsapp_accounts for the dev tenant.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING so repeated invocations are safe.
 * The conflict target is the partial unique index on phone_number_id WHERE deleted_at IS NULL.
 * Since the index is partial (not a unique constraint), we use a regular unique column
 * fallback. The wamid unique index is on wamid; for accounts, phone_number_id has a
 * partial unique index (WHERE deleted_at IS NULL). We rely on ON CONFLICT DO NOTHING
 * which applies to any conflict (including the partial index).
 *
 * @param sql - A postgres.js Sql client with sufficient privileges (admin/superuser).
 */
export async function runDevSeed(sql: postgres.Sql): Promise<void> {
  // Insert dev whatsapp_accounts row idempotently.
  // ON CONFLICT DO NOTHING handles: the partial unique index on (phone_number_id WHERE deleted_at IS NULL).
  await sql`
    INSERT INTO whatsapp_accounts
      (tenant_id, phone_number_id, display_phone_number, waba_id, is_active, access_token, deleted_at)
    VALUES
      (${DEV_TENANT_ID}::uuid,
       ${DEV_PHONE_NUMBER_ID},
       '+51000000000',
       'dev-waba-id',
       true,
       'dev-access-token',
       NULL)
    ON CONFLICT DO NOTHING
  `;

  // Backfill access_token for rows that already existed without the column
  // (idempotent: only updates rows where access_token is still NULL).
  await sql`
    UPDATE whatsapp_accounts
    SET access_token = 'dev-access-token'
    WHERE phone_number_id = ${DEV_PHONE_NUMBER_ID}
      AND access_token IS NULL
  `;
}

// ---------------------------------------------------------------------------
// Standalone script entrypoint
// ---------------------------------------------------------------------------

// When this module is the entry point (not imported), run the seed.
if (
  process.argv[1] &&
  (await import('node:url'))
    .fileURLToPath(import.meta.url)
    .replace(/\\/g, '/')
    .endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const { loadEnv } = await import('../config/env.js');
  const env = loadEnv();
  const sql = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  try {
    await runDevSeed(sql);
    console.info('[seed-dev] done — dev whatsapp_accounts row seeded');
  } finally {
    await sql.end();
  }
  process.exit(0);
}
