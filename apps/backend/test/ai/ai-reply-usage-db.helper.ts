/**
 * ai-reply-usage-db.helper.ts — Test-only helpers for the ai_reply_usage table.
 *
 * createTestDb() (test/_helpers/test-db.ts) applies migrations 0000–0004 only, so
 * suites that need ai_reply_usage apply 0009 on top through this helper. Suites
 * that do NOT apply it exercise the "table not migrated yet" fail-soft path.
 * TODO: register 0009 in test/_helpers/test-db.ts MIGRATION_FILES and drop this helper.
 *
 * truncate() needs no change: TRUNCATE contacts ... CASCADE also empties
 * ai_reply_usage through its contact_id foreign key.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as rawSql } from 'drizzle-orm';
import type { TestDb } from '../_helpers/test-db.js';

const MIGRATIONS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../drizzle');

/** Applies drizzle/0009_ai_reply_usage.sql as superuser (idempotent). */
export async function applyAiReplyUsageMigration(db: TestDb): Promise<void> {
  const sqlText = readFileSync(join(MIGRATIONS_DIR, '0009_ai_reply_usage.sql'), 'utf-8');
  await db.adminSql.unsafe(sqlText);
}

/** Every ai_reply_usage row of a tenant, oldest first (admin bypass — assertions only). */
export async function adminUsageRows(
  db: TestDb,
  tenantId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await db.adminQuery((tx) =>
    tx.execute(
      rawSql`SELECT * FROM ai_reply_usage WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at`,
    ),
  );
  return rows as unknown as Array<Record<string, unknown>>;
}

/** Outbound whatsapp_messages rows of a tenant (admin bypass — assertions only). */
export async function adminOutboundRows(
  db: TestDb,
  tenantId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await db.adminQuery((tx) =>
    tx.execute(
      rawSql`SELECT * FROM whatsapp_messages
             WHERE tenant_id = ${tenantId}::uuid AND direction = 'outbound'`,
    ),
  );
  return rows as unknown as Array<Record<string, unknown>>;
}
