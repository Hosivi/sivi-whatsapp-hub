/**
 * whatsapp.sivihub-outbox.int.test.ts — Integration tests for the inbound webhook's
 * sivihub_event_outbox enqueue (ADR-0048 corte 1, walking skeleton B2).
 *
 * Covers: enqueue happens only when (a) the message row was ACTUALLY inserted (not a
 * duplicate wamid) AND (b) the tenant has an active SiviHub link.
 *
 * STRICT TDD MODE — written RED before the wiring existed.
 */

import * as crypto from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { createSivihubLinkSecretCipher } from '../../src/sivihub-link/sivihub-link-secret-cipher.js';
import { storeOrReplaceActiveLink } from '../../src/sivihub-link/sivihub-links.repository.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PHONE_NUMBER_ID = 'outbox-pnid-1';
const VERIFY_TOKEN = 'test-verify-token';
const APP_SECRET = 'test-app-secret';
const KEY_HEX = 'e'.repeat(64);

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_ADMIN_URL: 'postgresql://unused:unused@localhost:5432/unused',
    AUTH_MODE: 'dev-header',
    PORT: 3001,
    LOG_LEVEL: 'silent',
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: APP_SECRET,
    DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost:5432/unused',
    SIVIHUB_LINK_ENCRYPTION_KEY: KEY_HEX,
    DATABASE_OUTBOX_URL: 'postgresql://app_outbox_drain:testpassword@localhost:5432/unused',
    ENABLE_DEV_ENDPOINTS: false,
    WHATSAPP_META_API_VERSION: 'v21.0',
    ...overrides,
  };
}

function makeMetaPayload(wamid: string, waId = '51987654321', textBody = 'Hola') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry_id',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '51111111111', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: 'Ana Duarte' }, wa_id: waId }],
              messages: [
                {
                  id: wamid,
                  from: waId,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: textBody },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

function computeSignature(rawBody: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(Buffer.from(rawBody));
  return `sha256=${hmac.digest('hex')}`;
}

async function postWebhook(app: ReturnType<typeof buildApp>, body: unknown) {
  const rawBody = JSON.stringify(body);
  return app.request('/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': computeSignature(rawBody, APP_SECRET),
    },
    body: rawBody,
  });
}

describe('inbound webhook -> sivihub_event_outbox enqueue', () => {
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

  it('enqueues message.received when the tenant has an active link', async () => {
    await seedActiveLink();
    const res = await postWebhook(app, makeMetaPayload('wamid-outbox-1'));
    expect(res.status).toBe(200);

    const rows = await outboxRowsFor(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('message.received');
    expect(rows[0]?.event_id).toBe('wamid-outbox-1');
    const payload = rows[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(data.author).toBe('contact');
    expect(data.direction).toBe('inbound');
  });

  it('does NOT enqueue when the tenant has no active link', async () => {
    const res = await postWebhook(app, makeMetaPayload('wamid-outbox-2'));
    expect(res.status).toBe(200);

    const rows = await outboxRowsFor(TENANT_A);
    expect(rows).toHaveLength(0);
  });

  it('does NOT enqueue again on a duplicate wamid delivery (message row not re-inserted)', async () => {
    await seedActiveLink();
    const payload = makeMetaPayload('wamid-outbox-dup');

    const res1 = await postWebhook(app, payload);
    expect(res1.status).toBe(200);
    const res2 = await postWebhook(app, payload);
    expect(res2.status).toBe(200);

    const rows = await outboxRowsFor(TENANT_A);
    // UNIQUE (link_id, event_id) would also de-dupe, but the real guard is that the
    // SECOND delivery's whatsapp_messages insert is itself a no-op (ON CONFLICT DO
    // NOTHING on wamid), so enqueueSivihubEvent must never even be called for it.
    expect(rows).toHaveLength(1);
  });
});
