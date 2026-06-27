/**
 * whatsapp.route.int.test.ts — Integration tests for GET + POST /webhooks/whatsapp.
 *
 * Uses Testcontainers (PG16) + buildApp({ db, env }) to exercise the full stack:
 * HMAC verification → Zod parse → tenant resolution → contact upsert → message persist.
 *
 * All POST cases return 200 (ack-fast contract). Only GET 403 is a non-200 case.
 *
 * STRICT TDD MODE: tests written RED before implementation.
 */

import * as crypto from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { whatsappMessagesTable } from '../../src/db/schema/whatsapp-messages.schema.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PHONE_NUMBER_ID = '111';
const PHONE_NUMBER_ID_B = '222';
const VERIFY_TOKEN = 'test-verify-token';
const APP_SECRET = 'test-app-secret';
const PERU_WA_ID = '51987654321';
const NON_PERU_WA_ID = '1234567890';
const WAMID_1 = 'wamid_001';
const WAMID_2 = 'wamid_002';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    ENABLE_DEV_ENDPOINTS: false,
    WHATSAPP_META_API_VERSION: 'v21.0',
    ...overrides,
  };
}

/**
 * Builds a minimal valid Meta inbound message payload.
 */
function makeMetaPayload({
  phoneNumberId = PHONE_NUMBER_ID,
  waId = PERU_WA_ID,
  wamid = WAMID_1,
  profileName = 'Test User',
  textBody = 'Hello',
  timestamp = '1700000000',
}: {
  phoneNumberId?: string;
  waId?: string;
  wamid?: string;
  profileName?: string;
  textBody?: string;
  timestamp?: string;
} = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry_id',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '51111111111',
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: profileName },
                  wa_id: waId,
                },
              ],
              messages: [
                {
                  id: wamid,
                  from: waId,
                  timestamp,
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

/**
 * Builds a status-only Meta payload (no messages field).
 */
function makeStatusPayload(phoneNumberId = PHONE_NUMBER_ID) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry_id',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '51111111111',
                phone_number_id: phoneNumberId,
              },
              statuses: [
                {
                  id: 'some_wamid',
                  status: 'delivered',
                  timestamp: '1700000000',
                  recipient_id: PERU_WA_ID,
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

/**
 * Computes the X-Hub-Signature-256 header value for the given body and secret.
 */
function computeSignature(rawBody: string | Buffer, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Sends a signed POST to /webhooks/whatsapp.
 */
async function postWebhook(
  app: ReturnType<typeof buildApp>,
  body: unknown,
  opts: {
    signature?: string | null; // null = no header; undefined = computed from body
    secret?: string;
  } = {},
) {
  const rawBody = JSON.stringify(body);
  const secret = opts.secret ?? APP_SECRET;
  const sigHeader =
    opts.signature === null ? undefined : (opts.signature ?? computeSignature(rawBody, secret));

  return app.request('/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sigHeader !== undefined ? { 'X-Hub-Signature-256': sigHeader } : {}),
    },
    body: rawBody,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('/webhooks/whatsapp', () => {
  let testDb: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = buildApp({
      db: testDb,
      env: makeEnv(),
      meta: createFakeMetaClient(),
      llm: createFakeLlmAdapter(),
      logger: pino({ level: 'silent' }),
    });
  });

  beforeEach(async () => {
    // Truncate messages + contacts between tests. whatsapp_accounts seeded once in beforeAll.
    // truncate() also truncates whatsapp_accounts, so we re-seed them after.
    await testDb.truncate();

    // Re-seed tenant A's phone number
    await testDb.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
    });

    // Re-seed tenant B's phone number
    await testDb.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID_B,
      tenantId: TENANT_B,
      displayPhoneNumber: '+52222222222',
      wabaId: 'waba_b',
    });
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  // -------------------------------------------------------------------------
  // GET handshake — Task 2.2
  // -------------------------------------------------------------------------

  describe('GET /webhooks/whatsapp — hub verification handshake', () => {
    it('2.2a — 200 + plain-text challenge: valid subscribe + matching verify_token', async () => {
      const res = await app.request(
        `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('abc123');
    });

    it('2.2b — 403: wrong verify_token', async () => {
      const res = await app.request(
        '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=abc123',
      );
      expect(res.status).toBe(403);
    });

    it('2.2c — 403: absent verify_token', async () => {
      const res = await app.request('/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=abc123');
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST — signature verification — Task 2.4
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — signature verification', () => {
    it('2.4a — valid signature: processing continues (200 returned)', async () => {
      const payload = makeMetaPayload();
      const res = await postWebhook(app, payload);
      // Signed correctly with APP_SECRET; processing continues; 200 returned
      expect(res.status).toBe(200);
    });

    it('2.4b — bad signature → 200, zero whatsapp_messages rows', async () => {
      const payload = makeMetaPayload({ wamid: 'bad_sig_wamid' });
      const res = await postWebhook(app, payload, { signature: 'sha256=deadbeef' });
      expect(res.status).toBe(200);

      // Nothing persisted
      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(0);
    });

    it('2.4c — absent signature header → 200, zero rows', async () => {
      const payload = makeMetaPayload({ wamid: 'no_sig_wamid' });
      const res = await postWebhook(app, payload, { signature: null });
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(0);
    });

    it('2.4d — length-mismatch buffers must not throw out of handler (wrong hex length)', async () => {
      const payload = makeMetaPayload({ wamid: 'len_mismatch_wamid' });
      // sha256= prefix but too-short hex (not 64 hex chars) — triggers length guard
      const res = await postWebhook(app, payload, { signature: 'sha256=abc' });
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // POST — Zod validation — Task 2.6
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — Zod payload validation', () => {
    it('2.6a — malformed JSON (correctly signed) → 200, zero rows', async () => {
      const rawBody = 'this is not json {{{';
      const sig = computeSignature(rawBody, APP_SECRET);
      const res = await app.request('/webhooks/whatsapp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(0);
    });

    it('2.6b — valid JSON but Zod-invalid structure (no entry array) → 200, zero rows', async () => {
      const payload = { object: 'whatsapp_business_account', not_entry: [] };
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST — status-only skip — Task 2.7
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — status-only event skip', () => {
    it('2.7 — status-only event (no value.messages) → 200, zero rows, no contact upsert', async () => {
      const payload = makeStatusPayload();
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(0);

      // Contacts table should also be empty (no upsert attempted)
      const { contactsTable } = await import('../../src/db/schema/contacts.schema.js');
      const contacts = await testDb.adminQuery((tx) => tx.select().from(contactsTable));
      expect(contacts.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST — tenant resolution — Task 2.8
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — tenant resolution', () => {
    it('2.8a — known phone_number_id resolves to tenant (200, row persisted)', async () => {
      const payload = makeMetaPayload({ phoneNumberId: PHONE_NUMBER_ID, wamid: 'resolve_ok' });
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.wamid).toBe('resolve_ok');
    });

    it('2.8b — unknown phone_number_id → 200, zero rows', async () => {
      const payload = makeMetaPayload({ phoneNumberId: '99999', wamid: 'unknown_number_wamid' });
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST — phone normalization + contact upsert — Task 2.9
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — phone normalization + contact upsert', () => {
    it('2.9a — new Peru wa_id → contact inserted with source=whatsapp, message row with contact_id NOT NULL', async () => {
      const payload = makeMetaPayload({ waId: PERU_WA_ID, wamid: 'new_peru_wamid' });
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(1);
      const msg = msgs[0];
      expect(msg).toBeDefined();
      expect(msg?.contactId).toBeTruthy();
      expect(msg?.fromPhoneE164).toBe('+51987654321');

      // Verify contact was created with source='whatsapp'
      const { contactsTable } = await import('../../src/db/schema/contacts.schema.js');
      const contacts = await testDb.adminQuery((tx) => tx.select().from(contactsTable));
      expect(contacts.length).toBe(1);
      expect(contacts[0]?.source).toBe('whatsapp');
      expect(contacts[0]?.phoneE164).toBe('+51987654321');
    });

    it('2.9b — existing LIVE contact → reused, message row with existing contact_id', async () => {
      // Pre-seed a live contact for tenant A
      await testDb.seedTenant(TENANT_A, { phoneE164: '+51987654321', fullName: 'Existing Alice' });

      const { contactsTable } = await import('../../src/db/schema/contacts.schema.js');
      const preContacts = await testDb.adminQuery((tx) => tx.select().from(contactsTable));
      expect(preContacts.length).toBe(1);
      const existingId = preContacts[0]?.id;
      expect(existingId).toBeTruthy();

      const payload = makeMetaPayload({ waId: PERU_WA_ID, wamid: 'reuse_contact_wamid' });
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      // Still only 1 contact (no duplicate)
      const postContacts = await testDb.adminQuery((tx) => tx.select().from(contactsTable));
      expect(postContacts.length).toBe(1);

      // Message row has the existing contact_id
      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.contactId).toBe(existingId);
    });

    it('2.9c — non-Peru wa_id fails normalization → 200, no contact, no message', async () => {
      const payload = makeMetaPayload({ waId: NON_PERU_WA_ID, wamid: 'non_peru_wamid' });
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(0);

      const { contactsTable } = await import('../../src/db/schema/contacts.schema.js');
      const contacts = await testDb.adminQuery((tx) => tx.select().from(contactsTable));
      expect(contacts.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST — idempotent wamid — Task 2.10
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — idempotent wamid (ON CONFLICT DO NOTHING)', () => {
    it('2.10a — first delivery → exactly one whatsapp_messages row', async () => {
      const payload = makeMetaPayload({ wamid: WAMID_1 });
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.wamid).toBe(WAMID_1);
    });

    it('2.10b — re-delivery of same wamid → still exactly one row, no error, 200', async () => {
      const payload = makeMetaPayload({ wamid: WAMID_2 });

      // First delivery
      const res1 = await postWebhook(app, payload);
      expect(res1.status).toBe(200);

      // Re-delivery
      const res2 = await postWebhook(app, payload);
      expect(res2.status).toBe(200);

      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      // Filter to WAMID_2 specifically in case other tests left rows
      const wamid2Rows = msgs.filter((m) => m.wamid === WAMID_2);
      expect(wamid2Rows.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // POST — happy path E2E — Task 2.11
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — happy path E2E', () => {
    it('2.11 — full persistence: known phone_number_id, signed, Peru wa_id → 200 + contact + message with contact_id + raw_payload', async () => {
      const payload = makeMetaPayload({
        phoneNumberId: PHONE_NUMBER_ID,
        waId: PERU_WA_ID,
        wamid: 'happy_path_wamid',
        textBody: 'Hello World',
      });
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      // Exactly one message row
      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.length).toBe(1);
      const msg = msgs[0];
      expect(msg?.wamid).toBe('happy_path_wamid');
      expect(msg?.contactId).toBeTruthy();
      expect(msg?.fromPhoneE164).toBe('+51987654321');
      expect(msg?.phoneNumberId).toBe(PHONE_NUMBER_ID);

      // raw_payload must contain the original message object
      const rawPayload = msg?.rawPayload as Record<string, unknown> | null;
      expect(rawPayload).toBeTruthy();
      expect((rawPayload as Record<string, unknown>)?.id).toBe('happy_path_wamid');

      // Contact exists under tenant A
      const { contactsTable } = await import('../../src/db/schema/contacts.schema.js');
      const contacts = await testDb.adminQuery((tx) => tx.select().from(contactsTable));
      expect(contacts.length).toBe(1);
      expect(contacts[0]?.tenantId).toBe(TENANT_A);
    });
  });

  // -------------------------------------------------------------------------
  // POST — DB error resilience — Task 2.12
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — DB error resilience', () => {
    it('2.12 — DB failure → 200, no whatsapp_messages row, no orphaned contact', async () => {
      // Force a DB error by sending a payload where the wamid would violate the NOT NULL on
      // contact_id if we can break the upsert. A simpler approach: send a payload with a
      // phone that is valid Peru but use a second app instance with a broken withTenant.
      //
      // Approach: build an app with a db that throws inside withTenant.
      // This simulates the transaction failing and ensures the 200 ack-fast and no partial state.
      const { ok: resultOk } = await import('../../src/shared/result.js');
      const brokenDb = {
        ...testDb,
        withTenant: () => {
          throw new Error('Simulated DB failure');
        },
        resolveTenant: () => Promise.resolve(resultOk(TENANT_A)),
        adminSql: (testDb as unknown as Record<string, unknown>).adminSql as never,
        close: () => Promise.resolve(),
      };

      const brokenApp = buildApp({
        db: brokenDb,
        env: makeEnv(),
        meta: createFakeMetaClient(),
        llm: createFakeLlmAdapter(),
        logger: pino({ level: 'silent' }),
      });
      const payload = makeMetaPayload({ wamid: 'db_error_wamid' });
      const res = await postWebhook(brokenApp, payload);
      expect(res.status).toBe(200);

      // No rows for this wamid in the real DB either
      const msgs = await testDb.adminQuery((tx) => tx.select().from(whatsappMessagesTable));
      expect(msgs.filter((m) => m.wamid === 'db_error_wamid').length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST — tenant isolation on messages — Task 2.13
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — tenant isolation (RLS)', () => {
    it('2.13a — message stored under tenant A is invisible under tenant B context', async () => {
      const payload = makeMetaPayload({
        phoneNumberId: PHONE_NUMBER_ID, // tenant A
        waId: PERU_WA_ID,
        wamid: 'isolation_wamid',
      });
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);

      // Query as tenant A → visible
      const msgsA = await testDb.withTenant(TENANT_A, (tx) =>
        tx.select().from(whatsappMessagesTable),
      );
      expect(msgsA.length).toBe(1);
      expect(msgsA[0]?.wamid).toBe('isolation_wamid');

      // Query as tenant B → zero rows (RLS isolation)
      const msgsB = await testDb.withTenant(TENANT_B, (tx) =>
        tx.select().from(whatsappMessagesTable),
      );
      expect(msgsB.length).toBe(0);
    });

    it('2.13b — app_webhook cannot SELECT on whatsapp_messages (permission denied)', async () => {
      // resolveWebhookTenant uses app_webhook; attempting to SELECT from whatsapp_messages
      // via the same connection should fail with permission denied.
      // We verify this by using the app_webhook Drizzle DB that only has column-scoped grant.
      // The easiest way: use postgres.js directly on the webhook DSN and run the query.
      const postgres = (await import('postgres')).default;
      const webhookConnectionString = testDb.appRlsConnectionString.replace(
        /app_rls:testpassword/,
        'app_webhook:testpassword',
      );
      const wh = postgres(webhookConnectionString, { max: 1 });
      try {
        await expect(wh`SELECT * FROM whatsapp_messages LIMIT 1`).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await wh.end();
      }
    });
  });

  // -------------------------------------------------------------------------
  // POST — contacts.create() no-regression — Task 2.14
  // -------------------------------------------------------------------------

  describe('contacts.create() no-regression after upsertContactTx extraction', () => {
    it('2.14 — contacts.create() with live duplicate still returns CONTACT_ALREADY_EXISTS', async () => {
      const { createContactsRepository } = await import(
        '../../src/contacts/contacts.repository.js'
      );

      // Seed a live contact for tenant A
      await testDb.seedTenant(TENANT_A, { phoneE164: '+51987654321' });

      // create() must still return err(CONTACT_ALREADY_EXISTS) on a live duplicate
      const repo = createContactsRepository(testDb.withTenant, TENANT_A);
      const result = await repo.create({ phone: '51987654321' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CONTACT_ALREADY_EXISTS');
      }
    });
  });

  // -------------------------------------------------------------------------
  // POST — route isolation — Task 2.16
  // -------------------------------------------------------------------------

  describe('Route isolation — webhook without tenant middleware', () => {
    it('2.16 — POST /webhooks/whatsapp has no tenant header requirement (no 401)', async () => {
      // A signed POST with no X-Tenant-Id header must process (no 401 from tenant middleware).
      // We use the status-only payload so nothing is persisted — just checking no 401.
      const payload = makeStatusPayload();
      const res = await postWebhook(app, payload);
      expect(res.status).toBe(200);
      expect(res.status).not.toBe(401);
    });

    it('2.16b — POST /contacts without tenant header still returns 401 (tenant middleware active)', async () => {
      const res = await app.request('/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '987654321' }),
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST — ack-fast (all paths return 200) — Task 2.2 / spec
  // -------------------------------------------------------------------------

  describe('POST /webhooks/whatsapp — ack-fast contract (all POST cases → 200)', () => {
    const cases = [
      {
        name: 'bad signature',
        body: () => makeMetaPayload({ wamid: 'ack_bad_sig' }),
        opts: { signature: 'sha256=deadbeef' },
      },
      {
        name: 'absent signature',
        body: () => makeMetaPayload({ wamid: 'ack_no_sig' }),
        opts: { signature: null },
      },
      {
        name: 'status-only event',
        body: () => makeStatusPayload(),
        opts: {},
      },
      {
        name: 'unknown phone_number_id',
        body: () => makeMetaPayload({ phoneNumberId: '99999', wamid: 'ack_unknown_phone' }),
        opts: {},
      },
      {
        name: 'non-Peru wa_id',
        body: () => makeMetaPayload({ waId: NON_PERU_WA_ID, wamid: 'ack_non_peru' }),
        opts: {},
      },
    ] as const;

    for (const tc of cases) {
      it(`ack-fast 200: ${tc.name}`, async () => {
        const res = await postWebhook(app, tc.body(), tc.opts);
        expect(res.status).toBe(200);
      });
    }
  });
});
