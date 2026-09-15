/**
 * whatsapp-send.sivihub-outbox.int.test.ts — Integration tests for the outbound
 * send's sivihub_event_outbox enqueue (ADR-0048 corte 1, walking skeleton B2).
 *
 * Covers: enqueue happens on a successful outbound send, with author 'agent' from
 * the manual /whatsapp-send route and 'ai' from sendWhatsappText's explicit param,
 * only when the tenant has an active SiviHub link.
 *
 * STRICT TDD MODE — written RED before the wiring existed.
 */

import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { createSivihubLinkSecretCipher } from '../../src/sivihub-link/sivihub-link-secret-cipher.js';
import { storeOrReplaceActiveLink } from '../../src/sivihub-link/sivihub-links.repository.js';
import { sendWhatsappText } from '../../src/whatsapp-send/whatsapp-send.service.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PHONE_NUMBER_ID = 'outbox-send-pnid-1';
const KEY_HEX = 'f'.repeat(64);

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_ADMIN_URL: 'postgresql://unused:unused@localhost:5432/unused',
    AUTH_MODE: 'dev-header',
    PORT: 3001,
    LOG_LEVEL: 'silent',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    WHATSAPP_APP_SECRET: 'test-app-secret',
    DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost:5432/unused',
    SIVIHUB_LINK_ENCRYPTION_KEY: KEY_HEX,
    DATABASE_OUTBOX_URL: 'postgresql://app_outbox_drain:testpassword@localhost:5432/unused',
    ENABLE_DEV_ENDPOINTS: false,
    WHATSAPP_META_API_VERSION: 'v21.0',
    ...overrides,
  };
}

describe('outbound send -> sivihub_event_outbox enqueue', () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({
      db,
      env: makeEnv(),
      meta: createFakeMetaClient(),
      llm: createFakeLlmAdapter(),
      logger: pino({ level: 'silent' }),
    });
  });

  beforeEach(async () => {
    await db.truncate();
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok-abc',
    });
  });

  afterAll(async () => {
    await db.teardown();
  });

  async function seedActiveLink() {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    await db.withTenant(TENANT_A, (tx) =>
      storeOrReplaceActiveLink(tx, TENANT_A, 'https://sivihub.pe/hooks', cipher.encrypt('secret')),
    );
  }

  async function outboxRowsFor(tenantId: string) {
    return db.adminSql`SELECT * FROM sivihub_event_outbox WHERE tenant_id = ${tenantId}::uuid`;
  }

  it('enqueues message.sent with author "agent" via the manual /whatsapp-send route', async () => {
    await seedActiveLink();

    const res = await app.request('/whatsapp-send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT_A },
      body: JSON.stringify({ to: '+51987654321', text: 'Hola desde el agente' }),
    });
    expect(res.status).toBe(200);

    const rows = await outboxRowsFor(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('message.sent');
    const payload = rows[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(data.author).toBe('agent');
    expect(data.direction).toBe('outbound');
  });

  it('enqueues message.sent with author "ai" when sendWhatsappText is called with author: "ai"', async () => {
    await seedActiveLink();
    const deps = {
      db,
      env: makeEnv(),
      meta: createFakeMetaClient(),
      llm: createFakeLlmAdapter(),
      logger: pino({ level: 'silent' }),
    };

    const result = await sendWhatsappText(deps, TENANT_A, {
      to: '+51987654321',
      text: 'Respuesta automática',
      author: 'ai',
    });
    expect(result.ok).toBe(true);

    const rows = await outboxRowsFor(TENANT_A);
    expect(rows).toHaveLength(1);
    const payload = rows[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(data.author).toBe('ai');
  });

  it('does NOT enqueue when the tenant has no active link', async () => {
    const res = await app.request('/whatsapp-send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT_A },
      body: JSON.stringify({ to: '+51987654321', text: 'sin vinculo' }),
    });
    expect(res.status).toBe(200);

    const rows = await outboxRowsFor(TENANT_A);
    expect(rows).toHaveLength(0);
  });
});
