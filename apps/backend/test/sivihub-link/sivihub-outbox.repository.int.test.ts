/**
 * sivihub-outbox.repository.int.test.ts — Integration tests for enqueueSivihubEvent
 * (migration 0007 + repository), against a real Postgres via Testcontainers.
 *
 * Covers business rule 3 (spec): an event is enqueued ONLY when the tenant has an
 * active link — never written otherwise — and the outbox's own idempotency guard
 * (UNIQUE (link_id, event_id)).
 *
 * STRICT TDD MODE — written RED before the migration/repository existed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSivihubLinkSecretCipher } from '../../src/sivihub-link/sivihub-link-secret-cipher.js';
import { storeOrReplaceActiveLink } from '../../src/sivihub-link/sivihub-links.repository.js';
import {
  type SivihubOutboxEventInput,
  enqueueSivihubEvent,
} from '../../src/sivihub-link/sivihub-outbox.repository.js';
import { type TestDb, createTestDb } from '../_helpers/test-db.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const KEY_HEX = 'd'.repeat(64);

const BASE_EVENT: SivihubOutboxEventInput = {
  type: 'message.received',
  providerMessageId: 'wamid.enqueue-test-1',
  direction: 'inbound',
  author: 'contact',
  contactExternalId: '+51987654321',
  contactName: 'Ana Duarte',
  body: 'Hola, tienen clases?',
  mediaRef: null,
  sentAt: new Date('2026-09-15T18:02:09.000Z'),
};

describe('enqueueSivihubEvent (migration 0007 + repository)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  async function seedActiveLink(tenantId: string, eventsUrl = 'https://sivihub.pe/hooks') {
    const cipher = createSivihubLinkSecretCipher(KEY_HEX);
    const { id } = await db.withTenant(tenantId, (tx) =>
      storeOrReplaceActiveLink(tx, tenantId, eventsUrl, cipher.encrypt('secret')),
    );
    return id;
  }

  it('enqueues a pending row scoped to the active link when one exists', async () => {
    const linkId = await seedActiveLink(TENANT_A);

    await db.withTenant(TENANT_A, (tx) => enqueueSivihubEvent(tx, TENANT_A, BASE_EVENT));

    const rows =
      await db.adminSql`SELECT * FROM sivihub_event_outbox WHERE tenant_id = ${TENANT_A}::uuid`;
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.link_id).toBe(linkId);
    expect(row.event_id).toBe(BASE_EVENT.providerMessageId);
    expect(row.type).toBe('message.received');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);

    const payload = row.payload as Record<string, unknown>;
    expect(payload.id).toBe(BASE_EVENT.providerMessageId);
    expect(payload.type).toBe('message.received');
    const data = payload.data as Record<string, unknown>;
    expect(data.provider_message_id).toBe(BASE_EVENT.providerMessageId);
    expect(data.direction).toBe('inbound');
    expect(data.author).toBe('contact');
    expect(data.body).toBe(BASE_EVENT.body);
    expect(data.sent_at).toBe('2026-09-15T18:02:09.000Z');
    expect(data.contact).toEqual({ external_id: '+51987654321', name: 'Ana Duarte' });
  });

  it('is a no-op — writes NOTHING — when the tenant has no active link', async () => {
    await db.withTenant(TENANT_A, (tx) => enqueueSivihubEvent(tx, TENANT_A, BASE_EVENT));

    const rows =
      await db.adminSql`SELECT * FROM sivihub_event_outbox WHERE tenant_id = ${TENANT_A}::uuid`;
    expect(rows).toHaveLength(0);
  });

  it('re-enqueuing the SAME event for the SAME link is a no-op (unique link_id+event_id)', async () => {
    await seedActiveLink(TENANT_A);

    await db.withTenant(TENANT_A, (tx) => enqueueSivihubEvent(tx, TENANT_A, BASE_EVENT));
    await db.withTenant(TENANT_A, (tx) => enqueueSivihubEvent(tx, TENANT_A, BASE_EVENT));

    const rows =
      await db.adminSql`SELECT * FROM sivihub_event_outbox WHERE tenant_id = ${TENANT_A}::uuid`;
    expect(rows).toHaveLength(1);
  });

  it('scopes enqueue per tenant — tenant B active link does not enqueue tenant A events', async () => {
    await seedActiveLink(TENANT_B);

    await db.withTenant(TENANT_A, (tx) => enqueueSivihubEvent(tx, TENANT_A, BASE_EVENT));

    const rowsA =
      await db.adminSql`SELECT * FROM sivihub_event_outbox WHERE tenant_id = ${TENANT_A}::uuid`;
    expect(rowsA).toHaveLength(0);
  });

  it('app_rls has SELECT + INSERT but NOT UPDATE on sivihub_event_outbox (drain-only mutation)', async () => {
    await seedActiveLink(TENANT_A);
    await db.withTenant(TENANT_A, (tx) => enqueueSivihubEvent(tx, TENANT_A, BASE_EVENT));

    let caught: unknown;
    try {
      await db.withTenant(TENANT_A, async (tx) => {
        const { sql: rawSql } = await import('drizzle-orm');
        return tx.execute(
          rawSql`UPDATE sivihub_event_outbox SET status = 'dead' WHERE tenant_id = ${TENANT_A}::uuid`,
        );
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // Drizzle wraps the raw PostgresError as `.cause` — the ACL error itself lives there.
    const cause = (caught as { cause?: unknown })?.cause;
    expect(String((cause as { message?: string } | undefined)?.message)).toMatch(
      /permission denied/i,
    );
  });

  it('app_outbox_drain gets permission denied on SELECT from whatsapp_messages, contacts, and whatsapp_accounts', async () => {
    // app_outbox_drain (0007) is scoped to exactly two tables — sivihub_event_outbox
    // (SELECT + UPDATE) and sivihub_links (SELECT) — via its own FOR ALL/FOR SELECT
    // policies. It must NEVER be able to read any other domain table.
    const postgres = (await import('postgres')).default;
    const drainSql = postgres(db.outboxDrainConnectionString, { max: 1 });
    try {
      await expect(drainSql`SELECT * FROM whatsapp_messages LIMIT 1`).rejects.toThrow(
        /permission denied/i,
      );
      await expect(drainSql`SELECT * FROM contacts LIMIT 1`).rejects.toThrow(/permission denied/i);
      await expect(drainSql`SELECT * FROM whatsapp_accounts LIMIT 1`).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await drainSql.end();
    }
  });
});
