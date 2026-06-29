/**
 * payment-config.repository.ts — TenantPaymentConfig repository factory.
 *
 * Key invariants (mirrors contacts.repository.ts):
 * - ALL database operations run inside withTenant(tenantId, ...) — no query ever
 *   reaches Postgres outside a tenant-pinned transaction.
 * - NO WHERE tenant_id anywhere — RLS handles tenant scoping entirely.
 * - Domain logic returns Result<T,E> — NEVER throws.
 *
 * save() semantics (upsert by provider):
 *   1. SELECT by provider inside withTenant.
 *   2. Row absent → INSERT RETURNING *.
 *   3. Row present (even soft-deleted) → UPDATE SET ... RETURNING *.
 *
 * find() semantics:
 *   Returns the first active (deleted_at IS NULL) row for the tenant's provider.
 *   Returns ok(null) when no active config exists.
 */

import { eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantRunner } from '../db/client.js';
import {
  mapRowToTenantPaymentConfig,
  tenantPaymentConfigTable,
} from '../db/schema/tenant-payment-config.schema.js';
import type { TenantPaymentConfig } from '../db/schema/tenant-payment-config.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type PaymentConfigError = { readonly code: 'DB_ERROR'; readonly cause?: unknown };

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type SavePaymentConfigInput = {
  readonly provider: string;
  readonly configured: boolean;
  readonly publicKey?: string | null;
};

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export type PaymentConfigRepository = {
  save(input: SavePaymentConfigInput): Promise<Result<TenantPaymentConfig, PaymentConfigError>>;
  find(): Promise<Result<TenantPaymentConfig | null, PaymentConfigError>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createPaymentConfigRepository = (
  withTenant: TenantRunner,
  tenantId: string,
): PaymentConfigRepository => {
  // ------------------------------------------------------------------
  // save — upsert by (tenant, provider)
  // ------------------------------------------------------------------
  const save = async (
    input: SavePaymentConfigInput,
  ): Promise<Result<TenantPaymentConfig, PaymentConfigError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      try {
        // SELECT existing row (including soft-deleted) for this provider.
        const rows = await tx
          .select()
          .from(tenantPaymentConfigTable)
          .where(eq(tenantPaymentConfigTable.provider, input.provider))
          .limit(1);

        const existing = rows[0];

        if (!existing) {
          // INSERT
          const inserted = await tx
            .insert(tenantPaymentConfigTable)
            .values({
              tenantId,
              provider: input.provider,
              configured: input.configured,
              publicKey: input.publicKey ?? null,
            })
            .returning();

          const row = inserted[0];
          if (!row) {
            return err({ code: 'DB_ERROR' });
          }
          return ok(mapRowToTenantPaymentConfig(row));
        }

        // UPDATE (resurrect soft-deleted rows too)
        const updated = await tx
          .update(tenantPaymentConfigTable)
          .set({
            configured: input.configured,
            publicKey: input.publicKey ?? null,
            deletedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(tenantPaymentConfigTable.id, existing.id))
          .returning();

        const row = updated[0];
        if (!row) {
          return err({ code: 'DB_ERROR' });
        }
        return ok(mapRowToTenantPaymentConfig(row));
      } catch (cause) {
        return err({ code: 'DB_ERROR', cause });
      }
    });
  };

  // ------------------------------------------------------------------
  // find — first active config for this tenant (via RLS)
  // ------------------------------------------------------------------
  const find = async (): Promise<Result<TenantPaymentConfig | null, PaymentConfigError>> => {
    return withTenant(tenantId, async (tx: PostgresJsDatabase) => {
      try {
        const rows = await tx
          .select()
          .from(tenantPaymentConfigTable)
          .where(isNull(tenantPaymentConfigTable.deletedAt))
          .limit(1);

        const row = rows[0];
        if (!row) {
          return ok(null);
        }
        return ok(mapRowToTenantPaymentConfig(row));
      } catch (cause) {
        return err({ code: 'DB_ERROR', cause });
      }
    });
  };

  return { save, find };
};
