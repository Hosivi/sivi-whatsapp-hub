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

import { and, eq } from 'drizzle-orm';
import { sql as rawSql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import type { Logger } from 'pino';
import pino from 'pino';
import postgres from 'postgres';
import type { Env } from '../config/env.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import { sivihubLinksTable } from './schema/sivihub-links.schema.js';
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

/**
 * Error returned by resolveSivihubLink when the link id is unknown OR the link
 * is not 'active'. Both collapse to the SAME code — S1's auth middleware answers
 * the identical 401 whether the link never existed or was revoked (ADR-0048
 * corte 4, S1 — "unknown link" and "inactive link" are indistinguishable to the
 * caller by design).
 */
export type SivihubLinkAuthLookupError = { readonly code: 'UNKNOWN_LINK' };

/** The columns S1's auth middleware needs to authenticate a SiviHub request. */
export type SivihubLinkAuth = {
  readonly id: string;
  readonly tenantId: string;
  readonly secretEncrypted: string;
};

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
  /**
   * Resolves a SiviHub link's tenant + encrypted secret from its id, using the SAME
   * low-privilege app_webhook handle (cross-tenant, column-scoped — ADR-0048 corte 4,
   * S1). Only an 'active' link resolves; an unknown id or a revoked link both
   * return err(UNKNOWN_LINK) so the caller never learns which case it was.
   */
  resolveSivihubLink(linkId: string): Promise<Result<SivihubLinkAuth, SivihubLinkAuthLookupError>>;
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createDbClient = (
  env: Env,
  // Defaults to a standalone error-level pino instance for callers that don't
  // thread one in (e.g. the sivihub:link CLI) — main.ts passes its own
  // configured logger so infrastructure failures land in the same sink as
  // everything else.
  logger: Logger = pino({ level: 'error' }),
): DbClient => {
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

  /**
   * Resolves a SiviHub link's tenant + encrypted secret from its id, using the SAME
   * app_webhook (low-privilege, cross-tenant) handle as resolveTenant (ADR-0048
   * corte 4, S1 — "the tenant comes from the link row, never from the request").
   * Selects EXPLICIT columns — the app_webhook column grant (0008) restricts to
   * id, tenant_id, secret_encrypted, status only.
   *
   * The WHERE clause filters status = 'active' directly — a revoked link and an
   * unknown id both return zero rows, so both collapse to the SAME err(UNKNOWN_LINK)
   * with no way for the caller to distinguish them.
   *
   * Wrapped in try/catch: linkId originates from an HTTP header and may not even be
   * a well-formed UUID — Postgres would throw "invalid input syntax for type uuid"
   * on a raw compare. That failure mode collapses to the same UNKNOWN_LINK result
   * rather than an unhandled 500.
   */
  const resolveSivihubLink = async (
    linkId: string,
  ): Promise<Result<SivihubLinkAuth, SivihubLinkAuthLookupError>> => {
    try {
      const rows = await lookupDb
        .select({
          id: sivihubLinksTable.id,
          tenantId: sivihubLinksTable.tenantId,
          secretEncrypted: sivihubLinksTable.secretEncrypted,
        })
        .from(sivihubLinksTable)
        .where(and(eq(sivihubLinksTable.id, linkId), eq(sivihubLinksTable.status, 'active')))
        .limit(1);

      const row = rows[0] ?? null;
      if (!row) {
        return err({ code: 'UNKNOWN_LINK' });
      }
      return ok({ id: row.id, tenantId: row.tenantId, secretEncrypted: row.secretEncrypted });
    } catch (cause) {
      // An infrastructure failure (Postgres down, connection refused, a
      // malformed linkId tripping the uuid cast, ...) must NOT be silently
      // indistinguishable from "everything is unauthorized" — the caller
      // still gets the SAME 401 via the identical UNKNOWN_LINK code, but the
      // operator needs to see this. NEVER log the secret (never read here
      // anyway), the message body (never seen here either), the raw error
      // message (may echo the offending value back), or the full link id —
      // only a short, non-identifying prefix for correlation.
      logger.error(
        {
          linkIdPrefix: linkId.slice(0, 8),
          causeType: cause instanceof Error ? cause.name : typeof cause,
        },
        'resolveSivihubLink: infrastructure failure resolving a SiviHub link',
      );
      return err({ code: 'UNKNOWN_LINK' });
    }
  };

  return {
    withTenant,
    adminSql,
    resolveTenant,
    resolveSivihubLink,
    close: async () => {
      await sql.end();
      await adminSql.end();
      await lookupSql.end();
    },
  };
};
