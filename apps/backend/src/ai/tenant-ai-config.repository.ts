/**
 * tenant-ai-config.repository.ts — Repository for tenant_ai_config.
 *
 * Provides getTenantAiConfig: the single query that determines whether AI
 * auto-reply is enabled for a tenant. Called by runAiReply (Lote B) before
 * any LLM interaction.
 *
 * RLS invariants:
 * - ALL queries run inside withTenant(tenantId, ...) — RLS scopes rows.
 * - NO WHERE tenant_id — withTenant sets the GUC; policy enforces isolation.
 * - NO adminSql handle anywhere in this file.
 *
 * Domain rules:
 * - Filter: deleted_at IS NULL AND enabled = true.
 * - 0 rows → ok(null) — AI disabled for this tenant.
 * - 1 row  → ok(row) — AI active with this config.
 * - >1 row → err(MULTIPLE_CONFIGS) — data inconsistency; caller must not proceed.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { TenantRunner } from '../db/client.js';
import {
  mapRowToTenantAiConfig,
  tenantAiConfigTable,
} from '../db/schema/tenant-ai-config.schema.js';
import type { TenantAiConfig } from '../db/schema/tenant-ai-config.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type TenantAiConfigError =
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown }
  | { readonly code: 'MULTIPLE_CONFIGS' };

// ---------------------------------------------------------------------------
// getTenantAiConfig
// ---------------------------------------------------------------------------

/**
 * Fetches the active AI config for a tenant.
 *
 * Returns:
 * - ok(null)                 — no active config (AI disabled or not configured)
 * - ok(TenantAiConfig)       — exactly one active config found
 * - err(MULTIPLE_CONFIGS)    — >1 active config found (data inconsistency)
 * - err(DB_ERROR)            — unexpected database error
 *
 * @param withTenant - TenantRunner (RLS-scoped)
 * @param tenantId   - UUID of the tenant
 */
export async function getTenantAiConfig(
  withTenant: TenantRunner,
  tenantId: string,
): Promise<Result<TenantAiConfig | null, TenantAiConfigError>> {
  try {
    return await withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantAiConfigTable)
        .where(and(isNull(tenantAiConfigTable.deletedAt), eq(tenantAiConfigTable.enabled, true)));

      if (rows.length === 0) return ok(null);
      if (rows.length > 1) return err({ code: 'MULTIPLE_CONFIGS' } as const);

      // biome-ignore lint/style/noNonNullAssertion: length checked above
      return ok(mapRowToTenantAiConfig(rows[0]!));
    });
  } catch (cause) {
    return err({ code: 'DB_ERROR', cause } as const);
  }
}
