/**
 * client.int.test.ts — Integration tests for DbClient.resolveTenant.
 *
 * Verifies:
 * - resolveTenant returns ok(tenantId) for a known phone_number_id
 * - resolveTenant returns err(UNKNOWN_PHONE_NUMBER_ID) for an unknown phone_number_id
 * - app_webhook can SELECT (phone_number_id, tenant_id) from whatsapp_accounts
 * - app_webhook CANNOT SELECT * (column grant restricts unlisted columns)
 * - app_webhook CANNOT SELECT from whatsapp_messages (no grant)
 * - app_webhook CANNOT SELECT from contacts (no grant)
 *
 * Uses Testcontainers + full migration stack (0000 + 0001 + 0002).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/env.js';
import { createDbClient } from '../../src/db/client.js';
import { makeIdempotent } from '../../src/db/migrate.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../drizzle');
const ALL_MIGRATIONS = ['0000_contacts.sql', '0001_routing.sql', '0002_whatsapp.sql'];
const APP_RLS_PASSWORD = 'testpassword';
const APP_WEBHOOK_PASSWORD = 'testpassword';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PHONE_NUMBER_ID = '12345';

describe('DbClient.resolveTenant', () => {
  let container: StartedPostgreSqlContainer;
  let adminSql: postgres.Sql;
  let env: Env;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('testdb')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();

    const adminConnectionString = container.getConnectionUri();
    adminSql = postgres(adminConnectionString, { max: 2 });

    // Apply all migrations
    for (const file of ALL_MIGRATIONS) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      const sql = makeIdempotent(raw, APP_RLS_PASSWORD, APP_WEBHOOK_PASSWORD);
      await adminSql.unsafe(sql);
    }

    // Seed a whatsapp_accounts row directly as superuser
    await adminSql`
      INSERT INTO whatsapp_accounts (tenant_id, phone_number_id, display_phone_number, waba_id)
      VALUES (${TENANT_A}::uuid, ${PHONE_NUMBER_ID}, '+51987654321', 'waba-123')
    `;

    const { hostname, port, pathname } = new URL(adminConnectionString);
    const appRlsConnectionString = `postgresql://app_rls:${APP_RLS_PASSWORD}@${hostname}:${port}${pathname}`;
    const appWebhookConnectionString = `postgresql://app_webhook:${APP_WEBHOOK_PASSWORD}@${hostname}:${port}${pathname}`;

    env = {
      DATABASE_URL: appRlsConnectionString,
      DATABASE_ADMIN_URL: adminConnectionString,
      DATABASE_WEBHOOK_URL: appWebhookConnectionString,
      AUTH_MODE: 'dev-header',
      PORT: 3001,
      LOG_LEVEL: 'silent',
      WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
      WHATSAPP_APP_SECRET: 'test-app-secret',
    };
  });

  afterAll(async () => {
    await adminSql?.end();
    await container?.stop();
  });

  it('returns ok(tenantId) for a known phone_number_id', async () => {
    const client = createDbClient(env);
    try {
      const result = await client.resolveTenant(PHONE_NUMBER_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(TENANT_A);
    } finally {
      await client.close();
    }
  });

  it('returns err(UNKNOWN_PHONE_NUMBER_ID) for an unknown phone_number_id', async () => {
    const client = createDbClient(env);
    try {
      const result = await client.resolveTenant('99999');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('UNKNOWN_PHONE_NUMBER_ID');
    } finally {
      await client.close();
    }
  });

  it('app_webhook can SELECT explicit columns from whatsapp_accounts', async () => {
    const { hostname, port, pathname } = new URL(container.getConnectionUri());
    const webhookSql = postgres(
      `postgresql://app_webhook:${APP_WEBHOOK_PASSWORD}@${hostname}:${port}${pathname}`,
      { max: 1 },
    );
    try {
      const rows =
        await webhookSql`SELECT phone_number_id, tenant_id FROM whatsapp_accounts WHERE phone_number_id = ${PHONE_NUMBER_ID}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.phone_number_id).toBe(PHONE_NUMBER_ID);
      expect(rows[0]?.tenant_id).toBe(TENANT_A);
    } finally {
      await webhookSql.end();
    }
  });

  it('app_webhook SELECT * on whatsapp_accounts is denied (column grant restricts unlisted cols)', async () => {
    const { hostname, port, pathname } = new URL(container.getConnectionUri());
    const webhookSql = postgres(
      `postgresql://app_webhook:${APP_WEBHOOK_PASSWORD}@${hostname}:${port}${pathname}`,
      { max: 1 },
    );
    try {
      await expect(webhookSql`SELECT * FROM whatsapp_accounts`).rejects.toThrow();
    } finally {
      await webhookSql.end();
    }
  });

  it('app_webhook cannot SELECT from whatsapp_messages (no grant)', async () => {
    const { hostname, port, pathname } = new URL(container.getConnectionUri());
    const webhookSql = postgres(
      `postgresql://app_webhook:${APP_WEBHOOK_PASSWORD}@${hostname}:${port}${pathname}`,
      { max: 1 },
    );
    try {
      await expect(webhookSql`SELECT * FROM whatsapp_messages`).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await webhookSql.end();
    }
  });

  it('app_webhook cannot SELECT from contacts (no grant)', async () => {
    const { hostname, port, pathname } = new URL(container.getConnectionUri());
    const webhookSql = postgres(
      `postgresql://app_webhook:${APP_WEBHOOK_PASSWORD}@${hostname}:${port}${pathname}`,
      { max: 1 },
    );
    try {
      await expect(webhookSql`SELECT * FROM contacts`).rejects.toThrow(/permission denied/i);
    } finally {
      await webhookSql.end();
    }
  });
});
