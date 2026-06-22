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

import { sql as rawSql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../config/env.js';

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

export type DbClient = {
  readonly withTenant: TenantRunner;
  /** Privileged handle — migration/bootstrap ONLY. Never pass to repositories. */
  readonly adminSql: postgres.Sql;
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

  return {
    withTenant,
    adminSql,
    close: async () => {
      await sql.end();
      await adminSql.end();
    },
  };
};
