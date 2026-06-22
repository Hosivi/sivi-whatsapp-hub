/**
 * main.ts — Web process entrypoint.
 *
 * Boot sequence:
 *   1. loadEnv() — validate configuration, fail-fast on misconfig
 *   2. createDbClient(env) — open the app_rls (non-superuser) pool + privileged admin handle
 *   3. buildApp({ db, env }) — mount health + contacts CRUD behind the tenant middleware
 *   4. Start @hono/node-server on env.PORT
 *   5. Register SIGTERM/SIGINT for graceful shutdown (closes DB pools)
 *
 * Migrations are NOT run here — use the dedicated `pnpm migrate` script
 * (src/db/migrate.ts) before serving so RLS + the app_rls role reach the database.
 *
 * Functional composition — no DI container, no classes, no decorators.
 */

import { serve } from '@hono/node-server';
import pino from 'pino';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDbClient } from './db/client.js';

const env = loadEnv();

const logger = pino({ level: env.LOG_LEVEL });

const db = createDbClient(env);

const app = buildApp({ db, env });

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    logger.info(`[main] sivi-whatsapp-hub listening on http://localhost:${info.port}`);
  },
);

const shutdown = (signal: string): void => {
  logger.info(`[main] received ${signal} — shutting down`);
  void db.close().finally(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
