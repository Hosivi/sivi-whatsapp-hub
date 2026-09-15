/**
 * sivihub-outbox-drain.int.test.ts — Integration tests for the outbox drain loop
 * (ADR-0048 corte 1, walking skeleton B3), against a real Postgres (Testcontainers)
 * and a local fake HTTP receiver that independently re-verifies the HMAC signature
 * using the SAME algorithm as SiviHub's hub-webhook-signature.ts.
 *
 * Covers: the full response table (delivered/dead/retry), next_attempt_at backoff,
 * dead after 12 attempts, re-signing the SAME body on every attempt, and clean
 * shutdown.
 *
 * STRICT TDD MODE — written RED before the drain existed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSivihubLinkSecretCipher } from '../../src/sivihub-link/sivihub-link-secret-cipher.js';
import { storeOrReplaceActiveLink } from '../../src/sivihub-link/sivihub-links.repository.js';
import {
  createSivihubOutboxDrainLoop,
  drainOnce,
} from '../../src/sivihub-link/sivihub-outbox-drain.js';
import { type TestDb, createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const KEY_HEX = '1'.repeat(64);
const RAW_SECRET = 'the-plaintext-hmac-secret-0123456789ab';

// ---------------------------------------------------------------------------
// Fake HTTP receiver — independently re-verifies the signature (never imports
// the Hub's own signer), the same way SiviHub's hub-webhook-signature.ts does.
// ---------------------------------------------------------------------------

type ReceivedRequest = {
  readonly headers: http.IncomingHttpHeaders;
  readonly rawBody: string;
  readonly signatureValid: boolean;
};

function verifyLikeSiviHub(
  secretHex: string,
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  nowSeconds: number,
): boolean {
  if (timestampHeader === undefined || signatureHeader === undefined) return false;
  if (!signatureHeader.startsWith('v1=')) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || !/^\d+$/.test(timestampHeader)) return false;
  if (Math.abs(nowSeconds - timestamp) > 300) return false;

  const secretBytes = Buffer.from(secretHex, 'hex');
  const expectedHex = createHmac('sha256', secretBytes)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const expected = Buffer.from(expectedHex, 'utf8');
  const received = Buffer.from(signatureHeader.slice(3), 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

type RespondFn = (
  req: ReceivedRequest,
  index: number,
) => { status: number; delayMs?: number } | Promise<{ status: number; delayMs?: number }>;

function createFakeReceiver(secretHex: string, respond: RespondFn) {
  const requests: ReceivedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const nowSeconds = Math.floor(Date.now() / 1000);
        const signatureValid = verifyLikeSiviHub(
          secretHex,
          rawBody,
          req.headers['x-sivi-timestamp'] as string | undefined,
          req.headers['x-sivi-signature'] as string | undefined,
          nowSeconds,
        );
        const record: ReceivedRequest = { headers: req.headers, rawBody, signatureValid };
        requests.push(record);

        const { status, delayMs } = await respond(record, requests.length - 1);
        if (delayMs !== undefined) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        try {
          res.writeHead(signatureValid ? status : 401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: status < 300 ? 'stored' : 'ignored' }));
        } catch {
          // client already disconnected (timeout test) — nothing to do.
        }
      })();
    });
  });

  return {
    requests,
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as AddressInfo;
      return `http://127.0.0.1:${address.port}/hooks`;
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('sivihub outbox drain (B3)', () => {
  let db: TestDb;
  let drainDb: ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;
  let cipher: ReturnType<typeof createSivihubLinkSecretCipher>;
  let postgres: typeof import('postgres').default;
  let drainSql: ReturnType<typeof import('postgres').default>;

  beforeAll(async () => {
    db = await createTestDb();
    cipher = createSivihubLinkSecretCipher(KEY_HEX);
    postgres = (await import('postgres')).default;
    const { drizzle } = await import('drizzle-orm/postgres-js');
    drainSql = postgres(db.outboxDrainConnectionString, { max: 2 });
    drainDb = drizzle(drainSql);
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await drainSql.end();
    await db.teardown();
  });

  async function seedLinkAndEvent(
    eventsUrl: string,
    opts: { attempts?: number; payload?: Record<string, unknown> } = {},
  ) {
    const secretEncrypted = cipher.encrypt(RAW_SECRET);
    const { id: linkId } = await db.withTenant(TENANT_A, (tx) =>
      storeOrReplaceActiveLink(tx, TENANT_A, eventsUrl, secretEncrypted),
    );

    const payload = opts.payload ?? {
      id: 'wamid.drain-test-1',
      type: 'message.received',
      occurred_at: '2026-09-15T18:02:11Z',
      data: {
        provider_message_id: 'wamid.drain-test-1',
        direction: 'inbound',
        author: 'contact',
        contact: { external_id: '+51987654321', name: 'Ana Duarte' },
        body: 'Hola',
        media_ref: null,
        sent_at: '2026-09-15T18:02:09Z',
      },
    };

    const rows = await db.adminSql`
      INSERT INTO sivihub_event_outbox
        (tenant_id, link_id, event_id, type, payload, status, attempts, next_attempt_at)
      VALUES
        (${TENANT_A}::uuid, ${linkId}::uuid, ${payload.id as string}, ${payload.type as string},
         ${JSON.stringify(payload)}::jsonb, 'pending', ${opts.attempts ?? 0}, now())
      RETURNING id
    `;
    return { linkId, outboxId: rows[0]?.id as string, payload };
  }

  async function fetchRow(id: string) {
    const rows = await db.adminSql`SELECT * FROM sivihub_event_outbox WHERE id = ${id}::uuid`;
    return rows[0] as Record<string, unknown> | undefined;
  }

  // -------------------------------------------------------------------------
  // Delivered
  // -------------------------------------------------------------------------

  it('2xx -> delivered, delivered_at set, attempts = 1', async () => {
    const receiver = createFakeReceiver(RAW_SECRET, () => ({ status: 200 }));
    const url = await receiver.listen();
    try {
      const { outboxId, payload } = await seedLinkAndEvent(url);

      const result = await drainOnce({ drainDb, cipher });
      expect(result.processed).toBe(1);

      const row = await fetchRow(outboxId);
      expect(row?.status).toBe('delivered');
      expect(row?.delivered_at).not.toBeNull();
      expect(row?.attempts).toBe(1);
      expect(row?.last_status).toBe('200');

      expect(receiver.requests).toHaveLength(1);
      const req = receiver.requests[0];
      expect(req?.signatureValid).toBe(true);
      expect(JSON.parse(req?.rawBody ?? '{}')).toEqual(payload);
    } finally {
      await receiver.close();
    }
  });

  // -------------------------------------------------------------------------
  // Dead immediately: 400 / 401 / 403
  // -------------------------------------------------------------------------

  it.each([400, 401, 403])('%d -> dead immediately, no retry scheduled', async (status) => {
    const receiver = createFakeReceiver(RAW_SECRET, () => ({ status }));
    const url = await receiver.listen();
    try {
      const { outboxId } = await seedLinkAndEvent(url);

      await drainOnce({ drainDb, cipher });

      const row = await fetchRow(outboxId);
      expect(row?.status).toBe('dead');
      expect(row?.attempts).toBe(1);
      expect(row?.last_status).toBe(String(status));
    } finally {
      await receiver.close();
    }
  });

  // -------------------------------------------------------------------------
  // Retry: 503, other 5xx, 408, 429 — with backoff
  // -------------------------------------------------------------------------

  it.each([503, 500, 502, 408, 429])(
    '%d -> retry: stays pending, attempts = 1, next_attempt_at ~30s ahead',
    async (status) => {
      const receiver = createFakeReceiver(RAW_SECRET, () => ({ status }));
      const url = await receiver.listen();
      try {
        const { outboxId } = await seedLinkAndEvent(url);
        const before = Date.now();

        await drainOnce({ drainDb, cipher });

        const row = await fetchRow(outboxId);
        expect(row?.status).toBe('pending');
        expect(row?.attempts).toBe(1);
        expect(row?.last_status).toBe(String(status));

        const nextAttemptAt = new Date(row?.next_attempt_at as string).getTime();
        const deltaSeconds = (nextAttemptAt - before) / 1000;
        // 30s backoff, generous tolerance for test/container overhead.
        expect(deltaSeconds).toBeGreaterThan(20);
        expect(deltaSeconds).toBeLessThan(45);
      } finally {
        await receiver.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Network error (connection refused) -> retry
  // -------------------------------------------------------------------------

  it('network error (connection refused) -> retry, last_status = "network_error"', async () => {
    const receiver = createFakeReceiver(RAW_SECRET, () => ({ status: 200 }));
    const url = await receiver.listen();
    await receiver.close(); // now nothing is listening at `url`

    const { outboxId } = await seedLinkAndEvent(url);
    await drainOnce({ drainDb, cipher });

    const row = await fetchRow(outboxId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.last_status).toBe('network_error');
  });

  // -------------------------------------------------------------------------
  // Timeout -> retry
  // -------------------------------------------------------------------------

  it('delivery timeout -> retry, last_status = "timeout"', async () => {
    const receiver = createFakeReceiver(RAW_SECRET, () => ({ status: 200, delayMs: 300 }));
    const url = await receiver.listen();
    try {
      const { outboxId } = await seedLinkAndEvent(url);

      await drainOnce({ drainDb, cipher, deliveryTimeoutMs: 50 });

      const row = await fetchRow(outboxId);
      expect(row?.status).toBe('pending');
      expect(row?.last_status).toBe('timeout');
    } finally {
      await receiver.close();
    }
  });

  // -------------------------------------------------------------------------
  // Dead after 12 attempts
  // -------------------------------------------------------------------------

  it('a 12th failing attempt goes dead even though the status would normally retry', async () => {
    const receiver = createFakeReceiver(RAW_SECRET, () => ({ status: 500 }));
    const url = await receiver.listen();
    try {
      const { outboxId } = await seedLinkAndEvent(url, { attempts: 11 });

      await drainOnce({ drainDb, cipher });

      const row = await fetchRow(outboxId);
      expect(row?.attempts).toBe(12);
      expect(row?.status).toBe('dead');
    } finally {
      await receiver.close();
    }
  });

  // -------------------------------------------------------------------------
  // Re-signing on every attempt: SAME body, DIFFERENT timestamp/signature
  // -------------------------------------------------------------------------

  it('re-signs with a fresh timestamp on every attempt — body stays byte-identical', async () => {
    const receiver = createFakeReceiver(RAW_SECRET, (_req, index) => ({
      status: index === 0 ? 500 : 200,
    }));
    const url = await receiver.listen();
    try {
      const { outboxId } = await seedLinkAndEvent(url);

      // Two clock readings a few seconds apart, both anchored to REAL now — the fake
      // receiver enforces the actual 300s replay window against wall-clock time, so
      // an arbitrary fixed date would fall outside it and be rejected with 401.
      const baseNowMs = Date.now();
      await drainOnce({ drainDb, cipher, clock: () => new Date(baseNowMs) });
      // Simulate the backoff window having elapsed so the SAME row is due again.
      await db.adminSql`UPDATE sivihub_event_outbox SET next_attempt_at = now() WHERE id = ${outboxId}::uuid`;
      await drainOnce({ drainDb, cipher, clock: () => new Date(baseNowMs + 2_000) });

      expect(receiver.requests).toHaveLength(2);
      const [first, second] = receiver.requests;
      expect(first?.signatureValid).toBe(true);
      expect(second?.signatureValid).toBe(true);
      expect(first?.headers['x-sivi-timestamp']).not.toBe(second?.headers['x-sivi-timestamp']);
      expect(first?.headers['x-sivi-signature']).not.toBe(second?.headers['x-sivi-signature']);
      // The BODY is byte-identical across both attempts.
      expect(first?.rawBody).toBe(second?.rawBody);

      const row = await fetchRow(outboxId);
      expect(row?.status).toBe('delivered');
      expect(row?.attempts).toBe(2);
    } finally {
      await receiver.close();
    }
  });

  // -------------------------------------------------------------------------
  // Clean shutdown
  // -------------------------------------------------------------------------

  describe('createSivihubOutboxDrainLoop — clean shutdown', () => {
    it('stop() awaits the in-flight batch and cancels further ticks', async () => {
      const receiver = createFakeReceiver(RAW_SECRET, () => ({ status: 200, delayMs: 80 }));
      const url = await receiver.listen();
      try {
        const { outboxId } = await seedLinkAndEvent(url);

        const loop = createSivihubOutboxDrainLoop({
          drainDb,
          cipher,
          pollIntervalMs: 20,
        });

        loop.start();
        // Let the first tick begin (it will be mid-flight inside the 80ms delay).
        await new Promise((r) => setTimeout(r, 10));
        await loop.stop();

        // The in-flight batch was awaited to completion — the row reached a
        // terminal state, never left mid-transaction.
        const row = await fetchRow(outboxId);
        expect(row?.status).toBe('delivered');

        const countAfterStop = receiver.requests.length;
        // Give the (cancelled) interval a chance to fire if it wrongly wasn't stopped.
        await new Promise((r) => setTimeout(r, 100));
        expect(receiver.requests.length).toBe(countAfterStop);
      } finally {
        await receiver.close();
      }
    });
  });
});
