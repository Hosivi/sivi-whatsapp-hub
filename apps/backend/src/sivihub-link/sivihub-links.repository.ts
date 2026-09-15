/**
 * sivihub-links.repository.ts — reads/writes for the sivihub_links table
 * (ADR-0048 corte 1, walking skeleton B1 + B2).
 *
 * Both functions take an already-tenant-scoped transaction (opened via
 * DbClient.withTenant) — RLS does the isolation; neither function filters by
 * tenant_id in SQL beyond what the policy already enforces (house convention).
 */

import { sql as rawSql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export type ActiveSivihubLink = {
  readonly id: string;
  readonly eventsUrl: string;
  readonly secretEncrypted: string;
};

/**
 * Stores or replaces the tenant's active link — the `sivihub:link` CLI's write path.
 * Upserts on the partial unique index (tenant_id) WHERE status = 'active' (migration
 * 0006): re-running the command replaces the previous events_url/secret in place
 * rather than accumulating rows (spec: "no hay «ver secreto»" — relink IS reset).
 */
export async function storeOrReplaceActiveLink(
  tx: PostgresJsDatabase,
  tenantId: string,
  eventsUrl: string,
  secretEncrypted: string,
): Promise<{ id: string }> {
  const result = await tx.execute(rawSql`
    INSERT INTO sivihub_links (tenant_id, events_url, secret_encrypted, status)
    VALUES (${tenantId}::uuid, ${eventsUrl}, ${secretEncrypted}, 'active')
    ON CONFLICT (tenant_id) WHERE status = 'active'
    DO UPDATE SET
      events_url = EXCLUDED.events_url,
      secret_encrypted = EXCLUDED.secret_encrypted,
      updated_at = now()
    RETURNING id
  `);
  const rows = result as unknown as Array<{ id: string }>;
  const row = rows[0];
  if (!row) {
    // Unreachable in practice — INSERT ... ON CONFLICT DO UPDATE always returns
    // exactly one row when RETURNING is present. Guards against a silent [] result.
    throw new Error('storeOrReplaceActiveLink: INSERT ... RETURNING returned no row');
  }
  return { id: row.id };
}

/**
 * Finds the tenant's active link. Callers that gate a write on "the tenant has an
 * active link" (spec business rule 3) MUST call this inside the SAME withTenant tx
 * as that write — RLS scopes the read to the tenant the tx's set_config named.
 */
export async function findActiveLink(
  tx: PostgresJsDatabase,
  tenantId: string,
): Promise<ActiveSivihubLink | null> {
  const result = await tx.execute(rawSql`
    SELECT id, events_url, secret_encrypted
    FROM sivihub_links
    WHERE tenant_id = ${tenantId}::uuid AND status = 'active'
    LIMIT 1
  `);
  const rows = result as unknown as Array<{
    id: string;
    events_url: string;
    secret_encrypted: string;
  }>;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { id: row.id, eventsUrl: row.events_url, secretEncrypted: row.secret_encrypted };
}
