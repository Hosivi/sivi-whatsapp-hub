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
import { createFakeLlmAdapter, createGeminiAdapter } from './ai/llm-adapter.js';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDbClient } from './db/client.js';
import { createDialog360Client } from './meta/dialog360-client.js';
import { createFakeMetaClient, createMetaClient } from './meta/meta-client.js';

const env = loadEnv();

const logger = pino({ level: env.LOG_LEVEL });

// Fail fast: 360dialog requires its base URL to be configured.
if (env.WHATSAPP_PROVIDER === 'dialog360' && !env.DIALOG360_BASE_URL) {
  throw new Error(
    '[main] WHATSAPP_PROVIDER=dialog360 requires DIALOG360_BASE_URL to be set. ' +
      'Sandbox: https://waba-sandbox.360dialog.io/v1 | Production: https://waba-v2.360dialog.io',
  );
}

const db = createDbClient(env);

// Provider selection:
//   dialog360 → 360dialog adapter (opt-in via env; works in dev so the sandbox is reachable)
//   dev       → fake client (no network calls, safe for local dev)
//   default   → Meta Cloud API
const meta =
  env.WHATSAPP_PROVIDER === 'dialog360'
    ? createDialog360Client(env.DIALOG360_BASE_URL as string)
    : env.ENABLE_DEV_ENDPOINTS
      ? createFakeMetaClient()
      : createMetaClient(env.WHATSAPP_META_API_VERSION);

// LLM adapter selection:
//   dev (ENABLE_DEV_ENDPOINTS) → fake adapter (no Gemini calls, safe for local dev)
//   default                    → real Gemini adapter (requires GEMINI_API_KEY)
const llm = env.ENABLE_DEV_ENDPOINTS
  ? createFakeLlmAdapter()
  : createGeminiAdapter(env.GEMINI_API_KEY ?? '', env.AI_MODEL);

const app = buildApp({ db, env, meta, llm, logger });

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
