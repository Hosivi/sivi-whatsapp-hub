/**
 * client.ts — Database client factory.
 *
 * Key invariant: SET LOCAL app.current_tenant runs in the SAME transaction as
 * every contacts query. withTenant() enforces this structurally by opening a
 * dedicated transaction, setting the tenant config via set_config(), and passing
 * a Drizzle transaction client bound to that same transaction connection.
 *
 * Repositories receive ONLY withTenant — never the raw db or adminSql handles.
 * adminSql is privileged and used exclusively for migration/bootstrap (main.ts / tests).
 *
 * Connection roles:
 * - sql (db)   → connects as app_rls (non-superuser, NOBYPASSRLS) via DATABASE_URL
 * - adminSql   → connects as superuser/table-owner via DATABASE_ADMIN_URL (migration only)
 *
 * Transaction approach:
 * Drizzle v0.45 wraps the postgres.js client. For transactions, we use db.transaction()
 * which yields a PostgresJsTransaction tx — the same transaction is used for both the
 * set_config() call and all subsequent repo queries.
 */

import { eq } from 'drizzle-orm';
import { sql as rawSql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../config/env.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import { whatsappAccountsTable } from './schema/whatsapp-accounts.schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * TenantRunner — the only path repositories have to the database.
 * Runs `run` inside a transaction where app.current_tenant is set to tenantId.
 * Uses set_config(key, val, true) which is equivalent to SET LOCAL — resets at
 * transaction boundary, never leaks across pooled connections.
 */
export type TenantRunner = <T>(
  tenantId: string,
  run: (tx: PostgresJsDatabase) => Promise<T>,
) => Promise<T>;

/** Error returned by resolveTenant when phone_number_id is not found. */
export type WebhookLookupError = { readonly code: 'UNKNOWN_PHONE_NUMBER_ID' };

export type DbClient = {
  readonly withTenant: TenantRunner;
  /** Privileged handle — migration/bootstrap ONLY. Never pass to repositories. */
  readonly adminSql: postgres.Sql;
  /**
   * Resolves tenant_id from phone_number_id using the low-privilege app_webhook handle.
   * Queries EXPLICIT columns (phone_number_id, tenant_id) — never SELECT *.
   * Returns ok(tenantId) if a row exists for phone_number_id; err(UNKNOWN_PHONE_NUMBER_ID) otherwise.
   * lookupSql is PRIVATE — not exposed on DbClient.
   */
  resolveTenant(phoneNumberId: string): Promise<Result<string, WebhookLookupError>>;
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createDbClient = (env: Env): DbClient => {
  // App runtime connection: non-superuser role (app_rls). RLS is enforced here.
  const sql = postgres(env.DATABASE_URL, { max: 10 });
  const db = drizzle(sql);

  const withTenant: TenantRunner = (tenantId, run) =>
    db.transaction(async (tx) => {
      // set_config(setting, value, is_local=true) === SET LOCAL — tx-scoped.
      // Parameterized to prevent any uuid string-interpolation risk.
      await tx.execute(rawSql`SELECT set_config('app.current_tenant', ${tenantId}, true)`);
      return run(tx);
    });

  // Privileged connection: used for migration execution in main.ts/tests.
  const adminSql = postgres(env.DATABASE_ADMIN_URL, { max: 2 });

  // Low-privilege webhook lookup connection: app_webhook role (NOSUPERUSER, NOBYPASSRLS).
  // Used ONLY for the cross-tenant phone_number_id → tenant_id resolution.
  // NEVER used for domain reads/writes. PRIVATE — not exposed on DbClient.
  const lookupSql = postgres(env.DATABASE_WEBHOOK_URL, { max: 2 });
  const lookupDb = drizzle(lookupSql);

  /**
   * Resolves tenant_id from phone_number_id using the app_webhook (low-privilege) handle.
   * Selects EXPLICIT columns — NEVER SELECT * (column grant restricts to phone_number_id,
   * tenant_id only; SELECT * would fail with permission denied).
   * NOTE: does NOT yet filter deleted_at (the app_webhook column grant does not expose it).
   * Safe today — no account soft-delete/deactivation flow exists, and the partial-unique index
   * (phone_number_id WHERE deleted_at IS NULL) allows only one live row per number. TODO: filter
   * deleted_at (and grant the column to app_webhook) before account deactivation ships.
   */
  const resolveTenant = async (
    phoneNumberId: string,
  ): Promise<Result<string, WebhookLookupError>> => {
    // app_webhook has a COLUMN-SCOPED grant: SELECT (phone_number_id, tenant_id).
    // We must select ONLY those explicit columns — never SELECT *.
    // No tenant GUC is set; webhook_config_read policy (USING true) allows cross-tenant reads.
    const rows = await lookupDb
      .select({
        phoneNumberId: whatsappAccountsTable.phoneNumberId,
        tenantId: whatsappAccountsTable.tenantId,
      })
      .from(whatsappAccountsTable)
      .where(eq(whatsappAccountsTable.phoneNumberId, phoneNumberId))
      .limit(1);

    const row = rows[0] ?? null;
    if (!row) {
      return err({ code: 'UNKNOWN_PHONE_NUMBER_ID' });
    }
    return ok(row.tenantId);
  };

  return {
    withTenant,
    adminSql,
    resolveTenant,
    close: async () => {
      await sql.end();
      await adminSql.end();
      await lookupSql.end();
    },
  };
};
