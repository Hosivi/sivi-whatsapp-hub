/**
 * fixed-replies.int.test.ts — Fixed replies end to end through POST /webhooks/whatsapp.
 *
 * Testcontainers (postgres:16-alpine + all migrations) + buildApp with the fake Meta
 * client and the fake LLM. AI_REPLY_ENABLED is off (the default), so every new inbound
 * text goes to the fixed replies.
 *
 * The reply runs in the background after the 200. Every run ends with exactly one
 * fixed_reply_* log line, so tests wait for that line before asserting — including
 * the assertions that nothing was sent.
 *
 * Covers:
 * - first message → greeting, sent through Meta and stored as an outbound message
 * - a second message within 24 h → no greeting
 * - "1" → hours, "asesor" → handoff, "gracias" → nothing
 * - a re-delivered wamid → no second reply
 * - tenant_reply_settings.enabled = false → the tenant is silent
 * - override texts and the business name from tenant_reply_settings
 * - a Meta send error → fixed_reply_failed, nothing stored
 * - runFixedReply never throws on a database failure
 */

import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLlmAdapter } from '../../src/ai/llm-adapter.js';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { runFixedReply } from '../../src/fixed-replies/fixed-reply.service.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { buildSignedMetaPayload } from '../../src/webhooks/sign-payload.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PHONE_NUMBER_ID = '111';
const APP_SECRET = 'test-app-secret';
const CUSTOMER_PHONE = '+51987654321';

const GREETING_NO_NAME =
  '¡Hola! Gracias por escribirnos. Responde 1 para ver nuestro horario o 2 para hablar con un asesor.';
const HANDOFF = 'Listo, un asesor te responderá por este chat en cuanto esté disponible.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(): Env {
  return {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_ADMIN_URL: 'postgresql://unused:unused@localhost:5432/unused',
    AUTH_MODE: 'dev-header',
    PORT: 3001,
    LOG_LEVEL: 'info',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    WHATSAPP_APP_SECRET: APP_SECRET,
    DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost:5432/unused',
    ENABLE_DEV_ENDPOINTS: false,
    AI_REPLY_ENABLED: false,
    WHATSAPP_META_API_VERSION: 'v21.0',
    AI_MODEL: 'gemini-2.5-flash',
  };
}

type LogLine = { level: number; msg: string } & Record<string, unknown>;

/** A pino logger that keeps every line in memory so tests can wait on log events. */
function makeRecordingLogger() {
  const lines: LogLine[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) });
  return { logger, lines };
}

type SignedMessage = ReturnType<typeof buildSignedMetaPayload>;

describe('fixed replies through POST /webhooks/whatsapp', () => {
  let testDb: TestDb;

  function makeApp() {
    const meta = createFakeMetaClient();
    const llm = createFakeLlmAdapter();
    const { logger, lines } = makeRecordingLogger();
    const app = buildApp({ db: testDb, env: makeEnv(), meta, llm, logger });

    const fixedReplyLogs = () => lines.filter((line) => line.msg.startsWith('fixed_reply_'));

    /** Posts an already signed inbound message (lets a test re-deliver the same wamid). */
    const deliver = async (message: SignedMessage) => {
      const res = await app.request('/webhooks/whatsapp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': message.signatureHeader,
        },
        body: message.payload,
      });
      expect(res.status).toBe(200);
    };

    /** Sends a new inbound text from the customer and waits for its fixed-reply log line. */
    const receive = async (text: string) => {
      const before = fixedReplyLogs().length;
      const message = buildSignedMetaPayload({
        phone: CUSTOMER_PHONE,
        text,
        phoneNumberId: PHONE_NUMBER_ID,
        appSecret: APP_SECRET,
      });
      await deliver(message);
      await vi.waitFor(() => expect(fixedReplyLogs().length).toBe(before + 1), { timeout: 5_000 });
      return message;
    };

    return { meta, llm, fixedReplyLogs, deliver, receive };
  }

  const outboundTexts = async () => {
    const rows = await testDb.adminSql<{ text_body: string }[]>`
      SELECT text_body FROM whatsapp_messages WHERE direction = 'outbound' ORDER BY created_at
    `;
    return rows.map((row) => row.text_body);
  };

  const seedReplySettings = async (values: {
    businessName?: string | null;
    greetingText?: string | null;
    hoursText?: string | null;
    handoffText?: string | null;
    enabled?: boolean;
  }) => {
    await testDb.adminSql`
      INSERT INTO tenant_reply_settings
        (tenant_id, business_name, greeting_text, hours_text, handoff_text, enabled)
      VALUES
        (${TENANT_A}::uuid,
         ${values.businessName ?? null},
         ${values.greetingText ?? null},
         ${values.hoursText ?? null},
         ${values.handoffText ?? null},
         ${values.enabled ?? true})
    `;
  };

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await testDb.truncate();
    await testDb.seedWhatsappAccount({
      phoneNumberId: PHONE_NUMBER_ID,
      tenantId: TENANT_A,
      displayPhoneNumber: '+51111111111',
      wabaId: 'waba_a',
      accessToken: 'test-access-token',
    });
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  it('first message → greeting, sent to the customer and stored as an outbound message', async () => {
    const { meta, llm, receive, fixedReplyLogs } = makeApp();

    await receive('Hola');

    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]?.to).toBe(CUSTOMER_PHONE);
    expect(meta.calls[0]?.text).toBe(GREETING_NO_NAME);
    expect(await outboundTexts()).toEqual([GREETING_NO_NAME]);
    expect(fixedReplyLogs()[0]?.msg).toBe('fixed_reply_sent kind=greeting');
    expect(llm.calls).toHaveLength(0);
  });

  it('a second message within 24 h gets no greeting', async () => {
    const { meta, receive, fixedReplyLogs } = makeApp();

    await receive('Hola');
    await receive('Hola, sigo aquí');

    expect(meta.calls).toHaveLength(1);
    expect(fixedReplyLogs()[1]?.msg).toBe('fixed_reply_skipped reason=NO_MATCH');
  });

  it('"1" → hours reply with the tenant hours text', async () => {
    await seedReplySettings({
      businessName: 'Bodega Rosa',
      hoursText: 'lunes a sábado, de 9:00 a 20:00',
    });
    const { meta, receive, fixedReplyLogs } = makeApp();

    await receive('Hola');
    await receive('1');

    expect(meta.calls.map((call) => call.text)).toEqual([
      '¡Hola! Gracias por escribir a Bodega Rosa. Responde 1 para ver nuestro horario o 2 para hablar con un asesor.',
      'Nuestro horario de atención es: lunes a sábado, de 9:00 a 20:00.',
    ]);
    expect(fixedReplyLogs()[1]?.msg).toBe('fixed_reply_sent kind=hours');
  });

  it('"asesor" → handoff reply', async () => {
    const { meta, receive, fixedReplyLogs } = makeApp();

    await receive('Hola');
    await receive('Quiero hablar con un ASESOR');

    expect(meta.calls[1]?.text).toBe(HANDOFF);
    expect(fixedReplyLogs()[1]?.msg).toBe('fixed_reply_sent kind=handoff');
  });

  it('"gracias" after the greeting → no reply', async () => {
    const { meta, receive } = makeApp();

    await receive('Hola');
    await receive('gracias');

    expect(meta.calls).toHaveLength(1);
    expect(await outboundTexts()).toEqual([GREETING_NO_NAME]);
  });

  it('a re-delivered wamid gets no second reply', async () => {
    const { meta, deliver, receive, fixedReplyLogs } = makeApp();

    const message = await receive('Hola');
    await deliver(message);
    // A re-delivery never starts a fixed reply, so there is no log line to wait for.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(meta.calls).toHaveLength(1);
    expect(fixedReplyLogs()).toHaveLength(1);
  });

  it('tenant_reply_settings.enabled = false silences the tenant', async () => {
    await seedReplySettings({ businessName: 'Bodega Rosa', enabled: false });
    const { meta, receive, fixedReplyLogs } = makeApp();

    await receive('Hola');
    await receive('2');

    expect(meta.calls).toHaveLength(0);
    expect(fixedReplyLogs().map((line) => line.msg)).toEqual([
      'fixed_reply_skipped reason=DISABLED',
      'fixed_reply_skipped reason=DISABLED',
    ]);
  });

  it('uses the per-tenant override texts', async () => {
    await seedReplySettings({
      businessName: 'Bodega Rosa',
      greetingText: '¡Bienvenido a {negocio}! Escribe 1 o 2.',
      handoffText: 'Una persona de {negocio} te escribe en breve.',
    });
    const { meta, receive } = makeApp();

    await receive('Buenas tardes');
    await receive('2');

    expect(meta.calls.map((call) => call.text)).toEqual([
      '¡Bienvenido a Bodega Rosa! Escribe 1 o 2.',
      'Una persona de Bodega Rosa te escribe en breve.',
    ]);
  });

  it('a Meta send error → fixed_reply_failed, nothing stored as outbound', async () => {
    const { meta, receive, fixedReplyLogs } = makeApp();
    meta.queueError({ code: 'META_API_ERROR', metaCode: 401, detail: 'expired token' });

    await receive('Hola');

    expect(meta.calls).toHaveLength(1);
    expect(fixedReplyLogs()[0]?.msg).toBe('fixed_reply_failed reason=SEND_FAILED');
    expect(await outboundTexts()).toEqual([]);
  });

  it('runFixedReply returns err(DB_ERROR) and never throws when the database fails', async () => {
    const meta = createFakeMetaClient();
    const { logger, lines } = makeRecordingLogger();
    const brokenDb = {
      ...testDb,
      withTenant: () => Promise.reject(new Error('Simulated DB failure')),
    };

    const result = await runFixedReply(
      { db: brokenDb, env: makeEnv(), meta, llm: createFakeLlmAdapter(), logger },
      TENANT_A,
      {
        contactId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        fromPhoneE164: CUSTOMER_PHONE,
        text: 'Hola',
        wamid: 'wamid.db-failure',
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DB_ERROR');
    expect(meta.calls).toHaveLength(0);
    expect(lines.map((line) => line.msg)).toEqual(['fixed_reply_failed reason=DB_ERROR']);
  });
});
