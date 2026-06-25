/**
 * whatsapp-send.int.test.ts — Integration tests for POST /whatsapp-send.
 *
 * Uses Testcontainers (PG16) + buildApp({ db: testDb, env, meta: createFakeMetaClient() }).
 * Exercises the full stack: tenant middleware → Zod → service → DB.
 *
 * Scenarios:
 * (a) Happy path: configured account + valid body → 200, outbound row persisted
 * (b) No active account → 404 NO_ACTIVE_ACCOUNT
 * (c) NULL token → 422 OUTBOUND_NOT_CONFIGURED
 * (d) >1 active account → 422 (treated as NO_ACTIVE_ACCOUNT in service, but test notes below)
 * (e) Soft-deleted account excluded → 404 NO_ACTIVE_ACCOUNT
 * (f) Meta 131047 → 422 WINDOW_CLOSED
 * (g) Other Meta error → 502 META_API_ERROR
 * (h) Network error → 502 NETWORK_ERROR
 * (i) Body validation — missing to → 422 VALIDATION_ERROR
 * (j) Body validation — non-E.164 to → 422 VALIDATION_ERROR
 * (k) Body validation — empty text → 422
 * (l) Missing X-Tenant-Id → 401
 * (m) Tenant isolation: tenant A send not visible to tenant B
 * (n) Inbound direction default: existing inbound webhook still produces direction='inbound'
 * (o) direction filter segregation: one inbound + one outbound, filter each
 *
 * STRICT TDD MODE — tests written before final run.
 */

import * as crypto from 'node:crypto';
import { sql as rawSql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { whatsappMessagesTable } from '../../src/db/schema/whatsapp-messages.schema.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { err } from '../../src/shared/result.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PHONE_NUMBER_ID = 'pnid-send-111';
const RECIPIENT_PHONE = '+51987654321';
const SEND_TEXT = 'Hola mundo';
const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

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

/** POST to /whatsapp-send with a given tenant and body. */
async function sendRequest(
  app: ReturnType<typeof buildApp>,
  tenantId: string | null,
  body: unknown,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tenantId !== null) headers['x-tenant-id'] = tenantId;
  return app.request('/whatsapp-send', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** Counts whatsapp_messages rows for a tenant (admin bypass). */
async function countMessages(db: TestDb, tenantId: string): Promise<number> {
  const rows = await db.adminQuery((tx) =>
    tx.execute(
      rawSql`SELECT COUNT(*)::int AS cnt FROM whatsapp_messages WHERE tenant_id = ${tenantId}::uuid`,
    ),
  );
  const row = (rows as Array<{ cnt: number }>)[0];
  return row?.cnt ?? 0;
}

/** Fetches all whatsapp_messages for a tenant (admin bypass). */
async function getMessages(db: TestDb, tenantId: string) {
  const rows = await db.adminQuery((tx) =>
    tx.execute(
      rawSql`SELECT * FROM whatsapp_messages WHERE tenant_id = ${tenantId}::uuid ORDER BY received_at`,
    ),
  );
  return rows as Array<Record<string, unknown>>;
}

/** Makes a signed inbound webhook payload and sends it (to test inbound direction). */
function makeInboundPayload(phoneNumberId: string, waId: string, wamid: string) {
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
              contacts: [{ profile: { name: 'Test User' }, wa_id: waId }],
              messages: [
                {
                  id: wamid,
                  from: waId,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'Inbound hello' },
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

function computeSignature(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(Buffer.from(body));
  return `sha256=${hmac.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /whatsapp-send — integration tests', () => {
  let db: TestDb;
  let meta: ReturnType<typeof createFakeMetaClient>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDb();
    meta = createFakeMetaClient();
    app = buildApp({ db, env: makeEnv(), meta });
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  // -------------------------------------------------------------------------
  // (a) Happy path
  // -------------------------------------------------------------------------

  it('(a) happy path: configured account + valid body → 200, outbound row persisted', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok-abc',
    });

    const res = await sendRequest(app, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.wamid).toBe('wamid-fake-1');
    expect(body.status).toBe('accepted');

    // Check DB row
    const messages = await getMessages(db, TENANT_A);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg['direction']).toBe('outbound');
    expect(msg['from_phone_e164']).toBe(RECIPIENT_PHONE);
    expect(msg['wamid']).toBe('wamid-fake-1');
    expect(msg['contact_id']).not.toBeNull();
    expect(msg['received_at']).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // (b) No active account
  // -------------------------------------------------------------------------

  it('(b) no active account → 404 NO_ACTIVE_ACCOUNT, zero rows', async () => {
    const res = await sendRequest(app, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NO_ACTIVE_ACCOUNT');
    expect(await countMessages(db, TENANT_A)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (c) NULL token
  // -------------------------------------------------------------------------

  it('(c) NULL token → 422 OUTBOUND_NOT_CONFIGURED, zero rows, Meta not called', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: null,
    });

    const callsBefore = meta.calls.length;
    const res = await sendRequest(app, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('OUTBOUND_NOT_CONFIGURED');
    expect(await countMessages(db, TENANT_A)).toBe(0);
    expect(meta.calls.length).toBe(callsBefore); // Meta not called
  });

  // -------------------------------------------------------------------------
  // (d) >1 active account
  // -------------------------------------------------------------------------

  it('(d) >1 active account → 404, zero rows', async () => {
    // Seed two accounts for the same tenant (admin direct insert bypasses unique index
    // since both rows need different phone_number_ids)
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok1',
    });
    await db.seedWhatsappAccount({
      phoneNumberId: 'pnid-send-222',
      tenantId: TENANT_A,
      displayPhoneNumber: '+51222222222',
      wabaId: 'waba_a',
      accessToken: 'tok2',
    });

    const res = await sendRequest(app, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NO_ACTIVE_ACCOUNT');
    expect(await countMessages(db, TENANT_A)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (e) Soft-deleted account excluded
  // -------------------------------------------------------------------------

  it('(e) soft-deleted account → 404 NO_ACTIVE_ACCOUNT', async () => {
    // Insert via admin directly with deleted_at set
    await db.adminQuery((tx) =>
      tx.execute(
        rawSql`
          INSERT INTO whatsapp_accounts
            (tenant_id, phone_number_id, display_phone_number, waba_id, is_active, access_token, deleted_at)
          VALUES
            (${TENANT_A}::uuid, ${PHONE_NUMBER_ID}, '+51111111111', 'waba_a', true, 'tok', now())
        `,
      ),
    );

    const res = await sendRequest(app, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NO_ACTIVE_ACCOUNT');
  });

  // -------------------------------------------------------------------------
  // (f) Meta 131047 → WINDOW_CLOSED
  // -------------------------------------------------------------------------

  it('(f) Meta 131047 → 422 WINDOW_CLOSED, zero rows', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok',
    });

    // New app instance with an error-queued fake
    const errMeta = createFakeMetaClient(err({ code: 'META_API_ERROR', metaCode: 131047 }));
    const errApp = buildApp({ db, env: makeEnv(), meta: errMeta });

    const res = await sendRequest(errApp, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('WINDOW_CLOSED');
    expect(await countMessages(db, TENANT_A)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (g) Other Meta error → META_API_ERROR
  // -------------------------------------------------------------------------

  it('(g) Meta 190 → 502 META_API_ERROR, zero rows', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok',
    });

    const errMeta = createFakeMetaClient(err({ code: 'META_API_ERROR', metaCode: 190 }));
    const errApp = buildApp({ db, env: makeEnv(), meta: errMeta });

    const res = await sendRequest(errApp, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('META_API_ERROR');
    expect(await countMessages(db, TENANT_A)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (h) Network error
  // -------------------------------------------------------------------------

  it('(h) NETWORK_ERROR → 502 NETWORK_ERROR, zero rows', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok',
    });

    const errMeta = createFakeMetaClient(err({ code: 'NETWORK_ERROR' }));
    const errApp = buildApp({ db, env: makeEnv(), meta: errMeta });

    const res = await sendRequest(errApp, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('NETWORK_ERROR');
    expect(await countMessages(db, TENANT_A)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (i) Body validation — missing to
  // -------------------------------------------------------------------------

  it('(i) body missing "to" → 422 VALIDATION_ERROR', async () => {
    const callsBefore = meta.calls.length;
    const res = await sendRequest(app, TENANT_A, { text: SEND_TEXT });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(meta.calls.length).toBe(callsBefore); // Meta not called
  });

  // -------------------------------------------------------------------------
  // (j) Body validation — non-E.164 to
  // -------------------------------------------------------------------------

  it('(j) non-E.164 "to" → 422 VALIDATION_ERROR', async () => {
    const res = await sendRequest(app, TENANT_A, { to: '987654321', text: SEND_TEXT });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // (k) Body validation — empty text
  // -------------------------------------------------------------------------

  it('(k) empty text → 422 VALIDATION_ERROR', async () => {
    const res = await sendRequest(app, TENANT_A, { to: RECIPIENT_PHONE, text: '' });
    expect(res.status).toBe(422);
  });

  // -------------------------------------------------------------------------
  // (l) Missing X-Tenant-Id
  // -------------------------------------------------------------------------

  it('(l) missing X-Tenant-Id → 401', async () => {
    const res = await sendRequest(app, null, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // (m) Tenant isolation: tenant A row not visible to tenant B
  // -------------------------------------------------------------------------

  it('(m) tenant isolation: tenant A send → 200; tenant B context sees zero rows', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok',
    });

    const res = await sendRequest(app, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(res.status).toBe(200);

    // Query under TENANT_A context via withTenant (RLS enforced)
    const rowsA = await db.withTenant(TENANT_A, async (tx) =>
      tx.execute(rawSql`SELECT * FROM whatsapp_messages`),
    );
    expect((rowsA as unknown[]).length).toBe(1);

    // Query under TENANT_B context via withTenant (RLS enforced — should see zero)
    const rowsB = await db.withTenant(TENANT_B, async (tx) =>
      tx.execute(rawSql`SELECT * FROM whatsapp_messages`),
    );
    expect((rowsB as unknown[]).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (n) Inbound direction default
  // -------------------------------------------------------------------------

  it('(n) inbound webhook still produces direction="inbound" after migration', async () => {
    // Seed a whatsapp account for tenant A (inbound webhook resolves tenant from phone_number_id)
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok',
    });

    const payload = makeInboundPayload(PHONE_NUMBER_ID, '51987654321', 'wamid-inbound-001');
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, APP_SECRET);

    const res = await app.request('/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
      },
      body: rawBody,
    });
    expect(res.status).toBe(200);

    const messages = await getMessages(db, TENANT_A);
    expect(messages).toHaveLength(1);
    expect(messages[0]!['direction']).toBe('inbound');
  });

  // -------------------------------------------------------------------------
  // (o) direction filter segregation
  // -------------------------------------------------------------------------

  it('(o) direction segregation: filter inbound → 1 row; filter outbound → 1 row', async () => {
    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'tok',
    });

    // Insert an inbound row via webhook
    const inboundPayload = makeInboundPayload(PHONE_NUMBER_ID, '51987654321', 'wamid-in-001');
    const rawBody = JSON.stringify(inboundPayload);
    await app.request('/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': computeSignature(rawBody, APP_SECRET),
      },
      body: rawBody,
    });

    // Insert an outbound row via send
    const sendRes = await sendRequest(app, TENANT_A, { to: RECIPIENT_PHONE, text: SEND_TEXT });
    expect(sendRes.status).toBe(200);

    // Two rows total
    const all = await getMessages(db, TENANT_A);
    expect(all).toHaveLength(2);

    // Filter by direction
    const inbound = await db.adminQuery((tx) =>
      tx.execute(
        rawSql`SELECT * FROM whatsapp_messages WHERE tenant_id = ${TENANT_A}::uuid AND direction = 'inbound'`,
      ),
    );
    expect((inbound as unknown[]).length).toBe(1);

    const outbound = await db.adminQuery((tx) =>
      tx.execute(
        rawSql`SELECT * FROM whatsapp_messages WHERE tenant_id = ${TENANT_A}::uuid AND direction = 'outbound'`,
      ),
    );
    expect((outbound as unknown[]).length).toBe(1);
  });
});
