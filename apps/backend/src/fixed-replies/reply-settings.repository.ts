/**
 * reply-settings.repository.ts — Repository for tenant_reply_settings.
 *
 * Provides getReplySettings: the per-tenant overrides for the fixed replies.
 *
 * RLS invariants:
 * - ALL queries run inside withTenant(tenantId, ...) — RLS scopes rows.
 * - NO WHERE tenant_id — withTenant sets the GUC; the policy enforces isolation.
 * - NO adminSql handle anywhere in this file.
 *
 * Domain rules:
 * - Filter: deleted_at IS NULL (the partial unique index allows at most one live row).
 * - 0 rows → ok(null) — the default texts in code apply.
 * - 1 row  → ok(settings), including enabled = false (the caller decides to stay silent).
 */

import { isNull } from 'drizzle-orm';
import type { TenantRunner } from '../db/client.js';
import {
  type TenantReplySettings,
  mapRowToTenantReplySettings,
  tenantReplySettingsTable,
} from '../db/schema/tenant-reply-settings.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';

export type ReplySettingsError = { readonly code: 'DB_ERROR'; readonly cause?: unknown };

/**
 * Fetches the live reply settings of a tenant.
 *
 * Returns:
 * - ok(null)                — no live row (use the defaults)
 * - ok(TenantReplySettings) — the tenant's live row
 * - err(DB_ERROR)           — unexpected database error
 *
 * @param withTenant - TenantRunner (RLS-scoped)
 * @param tenantId   - UUID of the tenant
 */
export async function getReplySettings(
  withTenant: TenantRunner,
  tenantId: string,
): Promise<Result<TenantReplySettings | null, ReplySettingsError>> {
  try {
    return await withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantReplySettingsTable)
        .where(isNull(tenantReplySettingsTable.deletedAt))
        .limit(1);

      const row = rows[0];
      return ok(row === undefined ? null : mapRowToTenantReplySettings(row));
    });
  } catch (cause) {
    return err({ code: 'DB_ERROR', cause } as const);
  }
}
