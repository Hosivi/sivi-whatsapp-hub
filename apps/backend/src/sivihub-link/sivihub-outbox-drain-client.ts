/**
 * sivihub-outbox-drain-client.ts — the drain loop's dedicated DB connection
 * (ADR-0048 corte 1, walking skeleton B3).
 *
 * Connects as app_outbox_drain (0007_sivihub_event_outbox.sql): NOSUPERUSER,
 * NOBYPASSRLS, granted SELECT/UPDATE on sivihub_event_outbox and SELECT on
 * sivihub_links ONLY, via cross-tenant FOR ALL/FOR SELECT policies scoped to
 * exactly those two tables. It can never read whatsapp_messages, contacts, or any
 * other domain table — least privilege, mirroring the existing app_webhook
 * precedent (0002_whatsapp.sql), rather than reusing DbClient.adminSql (reserved
 * for migration/bootstrap only — see the warning in db/client.ts).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../config/env.js';

export type OutboxDrainDb = {
  readonly db: PostgresJsDatabase;
  readonly close: () => Promise<void>;
};

export function createOutboxDrainDb(env: Env): OutboxDrainDb {
  const sql = postgres(env.DATABASE_OUTBOX_URL, { max: 2 });
  return {
    db: drizzle(sql),
    close: () => sql.end(),
  };
}
