/**
 * sivihub-messages.route.int.test.ts — Integration tests for S2, POST
 * /sivihub/messages (ADR-0048 corte 4, behind S1's service-auth middleware).
 *
 * Uses Testcontainers (PG16) + buildApp({ db: testDb, meta: createFakeMetaClient() }).
 *
 * Scenarios:
 * (a) happy path → 200 { wamid, sentAt }, sentAt matches the stored row exactly
 * (b) the outbox row is enqueued exactly once (message.sent, author: 'agent')
 * (c) Meta 131047 (24h window) → a distinct, stable error code — never a 500
 * (d) an unsigned request never reaches the handler (Meta not called, no row)
 * (e) validation: unknown extra field → 422 (strict body)
 * (f) Meta sends, the DB insert throws → 500 INTERNAL_ERROR, cause not leaked,
 *     the already-sent message is logged for reconciliation without its body
 * (g) per-link rate limit: under the configured max → 200; one more in the
 *     same window → 429 with Retry-After
 * (h) two different links never share a rate-limit budget
 *
 * STRICT TDD MODE — written RED before implementation.
 */

import { sql as rawSql } from 'drizzle-orm';
import type { Logger } from 'pino';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import type { TenantRunner } from '../../src/db/client.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { err } from '../../src/shared/result.js';
import {
  SIVIHUB_LINK_ID_HEADER,
  SIVIHUB_SIGNATURE_HEADER,
  SIVIHUB_TIMESTAMP_HEADER,
} from '../../src/sivihub-inbound/sivihub-inbound-signature.js';
import { createSivihubLinkSecretCipher } from '../../src/sivihub-link/sivihub-link-secret-cipher.js';
import { storeOrReplaceActiveLink } from '../../src/sivihub-link/sivihub-links.repository.js';
import { signSivihubEvent } from '../../src/sivihub-link/sivihub-outbox-signature.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const KEY_HEX = 'f'.repeat(64);
const SECRET_HEX = '1'.repeat(64);
const PHONE_NUMBER_ID = 'sivihub-messages-pnid-1';
const RECIPIENT_PHONE = '+51987654321';
const SEND_TEXT = 'Hola desde SiviHub';

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

function signedHeaders(linkId: string, rawBody: string): Record<string, string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    [SIVIHUB_LINK_ID_HEADER]: linkId,
    [SIVIHUB_TIMESTAMP_HEADER]: String(nowSeconds),
    [SIVIHUB_SIGNATURE_HEADER]: signSivihubEvent(SECRET_HEX, rawBody, nowSeconds),
  };
}

describe('POST /sivihub/messages — S2 integration tests', () => {
  let db: TestDb;
  const cipher = createSivihubLinkSecretCipher(KEY_HEX);

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

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.teardown();
  });

  async function seedLink(): Promise<string> {
    const { id } = await db.withTenant(TENANT_A, (tx) =>
      storeOrReplaceActiveLink(
        tx,
        TENANT_A,
        'https://sivihub.pe/hooks',
        cipher.encrypt(SECRET_HEX),
      ),
    );
    return id;
  }

  function buildApp_(meta: ReturnType<typeof createFakeMetaClient>) {
    return buildApp({
      db,
      env: makeEnv(),
      meta,
      llm: createFakeLlmAdapter(),
      logger: pino({ level: 'silent' }),
      sivihubLinkCipher: cipher,
    });
  }

  it('(a) happy path → 200 { wamid, sentAt }; sentAt matches the stored row exactly', async () => {
    const linkId = await seedLink();
    const app = buildApp_(createFakeMetaClient());
    const rawBody = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT });

    const res = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkId, rawBody),
      body: rawBody,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wamid).toBe('wamid-fake-1');
    expect(typeof body.sentAt).toBe('string');

    const rows = await db.adminQuery((tx) =>
      tx.execute(
        rawSql`SELECT wamid, received_at FROM whatsapp_messages WHERE tenant_id = ${TENANT_A}::uuid`,
      ),
    );
    const stored = (rows as Array<{ wamid: string; received_at: Date }>)[0];
    expect(stored?.wamid).toBe(body.wamid);
    // The route's sentAt, round-tripped through ISO, must equal the stored column.
    expect(new Date(body.sentAt).toISOString()).toBe(
      new Date(stored?.received_at ?? 0).toISOString(),
    );
  });

  it('(b) the outbox row is enqueued exactly once (message.sent, author "agent")', async () => {
    const linkId = await seedLink();
    const app = buildApp_(createFakeMetaClient());
    const rawBody = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT });

    const res = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkId, rawBody),
      body: rawBody,
    });
    expect(res.status).toBe(200);

    const rows =
      await db.adminSql`SELECT * FROM sivihub_event_outbox WHERE tenant_id = ${TENANT_A}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('message.sent');
    const payload = rows[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(data.author).toBe('agent');
  });

  it('(c) Meta 131047 (24h window) → a distinct, stable error code, never a 500', async () => {
    const linkId = await seedLink();
    const errMeta = createFakeMetaClient(err({ code: 'META_API_ERROR', metaCode: 131047 }));
    const app = buildApp_(errMeta);
    const rawBody = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT });

    const res = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkId, rawBody),
      body: rawBody,
    });

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('WINDOW_CLOSED');
  });

  it('(d) an unsigned request never reaches the handler — Meta not called, no row persisted', async () => {
    const meta = createFakeMetaClient();
    const app = buildApp_(meta);
    const rawBody = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT });

    const callsBefore = meta.calls.length;
    const res = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(meta.calls.length).toBe(callsBefore);

    const rows = await db.adminQuery((tx) =>
      tx.execute(rawSql`SELECT * FROM whatsapp_messages WHERE tenant_id = ${TENANT_A}::uuid`),
    );
    expect((rows as unknown[]).length).toBe(0);
  });

  it('(e) unknown extra field in body → 422 VALIDATION_ERROR (strict schema)', async () => {
    const linkId = await seedLink();
    const app = buildApp_(createFakeMetaClient());
    const rawBody = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT, extra: 'nope' });

    const res = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkId, rawBody),
      body: rawBody,
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('(f) Meta sends, the DB insert throws → 500 INTERNAL_ERROR; cause not leaked; a log line records the already-sent message without its body', async () => {
    const linkId = await seedLink();
    const meta = createFakeMetaClient();

    // The account-read tx (1st withTenant call) delegates to the REAL Testcontainers
    // db so resolveActiveAccount genuinely succeeds; the write tx (2nd call) throws
    // to simulate "Meta sent, then the DB insert failed" without needing a real
    // Postgres constraint violation.
    let withTenantCallCount = 0;
    const dbWithFailingWrite = {
      ...db,
      withTenant: (async (tenantId: string, run: (tx: unknown) => Promise<unknown>) => {
        withTenantCallCount++;
        if (withTenantCallCount === 1) {
          return db.withTenant(tenantId, run as never);
        }
        throw new Error('simulated write-tx failure: connection lost');
      }) as TenantRunner,
    };

    const logCalls: unknown[][] = [];
    const fakeLogger = {
      error: (...args: unknown[]) => {
        logCalls.push(args);
      },
    } as unknown as Logger;

    const app = buildApp({
      db: dbWithFailingWrite,
      env: makeEnv(),
      meta,
      llm: createFakeLlmAdapter(),
      logger: fakeLogger,
      sivihubLinkCipher: cipher,
    });

    const rawBody = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT });
    const callsBefore = meta.calls.length;

    const res = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkId, rawBody),
      body: rawBody,
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'INTERNAL_ERROR' });

    // Meta WAS called — the send is never rolled back once it succeeded.
    expect(meta.calls.length).toBe(callsBefore + 1);

    // The failure must be visible for manual reconciliation — but never with
    // the message body in the log line.
    expect(logCalls.length).toBeGreaterThanOrEqual(1);
    const loggedText = JSON.stringify(logCalls);
    expect(loggedText).not.toContain(SEND_TEXT);
  });

  it('(g) per-link rate limit: under the max → 200; one more in the same window → 429 with Retry-After', async () => {
    const linkId = await seedLink();
    const app = buildApp({
      db,
      env: makeEnv({
        SIVIHUB_MESSAGES_RATE_LIMIT_MAX: 2,
        SIVIHUB_MESSAGES_RATE_LIMIT_WINDOW_MS: 60_000,
      }),
      meta: createFakeMetaClient(),
      llm: createFakeLlmAdapter(),
      logger: pino({ level: 'silent' }),
      sivihubLinkCipher: cipher,
    });
    const rawBody = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT });

    const res1 = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkId, rawBody),
      body: rawBody,
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkId, rawBody),
      body: rawBody,
    });
    expect(res2.status).toBe(200);

    const res3 = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkId, rawBody),
      body: rawBody,
    });
    expect(res3.status).toBe(429);
    const body3 = await res3.json();
    expect(body3).toEqual({ error: 'RATE_LIMITED' });
    const retryAfter = res3.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('(h) two different links never share a rate-limit budget', async () => {
    const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const SECRET_B_HEX = '2'.repeat(64);
    const PHONE_NUMBER_ID_B = 'sivihub-messages-pnid-2';

    const linkA = await seedLink();

    await db.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID_B,
      tenantId: TENANT_B,
      displayPhoneNumber: '+51222222222',
      wabaId: 'waba_b',
      accessToken: 'tok-b',
    });
    const { id: linkB } = await db.withTenant(TENANT_B, (tx) =>
      storeOrReplaceActiveLink(
        tx,
        TENANT_B,
        'https://sivihub.pe/hooks',
        cipher.encrypt(SECRET_B_HEX),
      ),
    );

    const app = buildApp({
      db,
      env: makeEnv({
        SIVIHUB_MESSAGES_RATE_LIMIT_MAX: 1,
        SIVIHUB_MESSAGES_RATE_LIMIT_WINDOW_MS: 60_000,
      }),
      meta: createFakeMetaClient(),
      llm: createFakeLlmAdapter(),
      logger: pino({ level: 'silent' }),
      sivihubLinkCipher: cipher,
    });

    const rawBodyA = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT });
    const resA1 = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkA, rawBodyA),
      body: rawBodyA,
    });
    expect(resA1.status).toBe(200);

    // Link A is now over its (max=1) budget for this window.
    const resA2 = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: signedHeaders(linkA, rawBodyA),
      body: rawBodyA,
    });
    expect(resA2.status).toBe(429);

    // Link B has its OWN budget — unaffected by link A's usage.
    const rawBodyB = JSON.stringify({ to: RECIPIENT_PHONE, text: SEND_TEXT });
    const nowSecondsB = Math.floor(Date.now() / 1000);
    const resB1 = await app.request('/sivihub/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIVIHUB_LINK_ID_HEADER]: linkB,
        [SIVIHUB_TIMESTAMP_HEADER]: String(nowSecondsB),
        [SIVIHUB_SIGNATURE_HEADER]: signSivihubEvent(SECRET_B_HEX, rawBodyB, nowSecondsB),
      },
      body: rawBodyB,
    });
    expect(resB1.status).toBe(200);
  });
});
