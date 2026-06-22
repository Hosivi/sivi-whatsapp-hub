/**
 * main.ts — Web process entrypoint.
 *
 * Boot sequence:
 *   1. Build the Hono app via buildApp()
 *   2. Start @hono/node-server on PORT (default 3001)
 *   3. Register SIGTERM/SIGINT for graceful shutdown
 *
 * No database, no DI container — functional composition only.
 */

import { serve } from '@hono/node-server';
import pino from 'pino';
import { buildApp } from './app.js';

const DEFAULT_PORT = 3001;

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const app = buildApp();

const port = Number(process.env.PORT ?? DEFAULT_PORT);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    logger.info(`[main] sivi-whatsapp-hub listening on http://localhost:${info.port}`);
  },
);

const shutdown = (signal: string): void => {
  logger.info(`[main] received ${signal} — shutting down`);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
