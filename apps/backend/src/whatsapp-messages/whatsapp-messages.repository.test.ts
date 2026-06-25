/**
 * whatsapp-messages.repository.test.ts — Unit tests for the messages repository.
 *
 * Pure unit tests: no DB, no Testcontainers. The TenantRunner is stubbed with a
 * minimal in-memory fake that returns controlled rows directly.
 *
 * Why pure unit (no DB):
 * - The repository's logic under test is the SELECT field list and the row map.
 *   A fake TenantRunner that returns hard-coded rows is sufficient to assert the
 *   DTO shape without any infrastructure.
 * - Integration tests (Testcontainers) would add 30+ s to CI for a 3-line additive change.
 */

import { describe, expect, it } from 'vitest';
import type { TenantRunner } from '../db/client.js';
import { type MessageDTO, listMessages } from './whatsapp-messages.repository.js';

// ---------------------------------------------------------------------------
// Fake row shape — mirrors what Drizzle's .select({...}) returns from the DB.
// We return a raw row object, bypassing Drizzle — the repository's row map is
// the unit under test.
// ---------------------------------------------------------------------------

type FakeRow = {
  wamid: string;
  name: string | null;
  phone: string;
  text: string | null;
  type: string;
  receivedAt: Date;
  direction: string;
};

/**
 * Builds a minimal TenantRunner stub that, when called, runs the `run` callback
 * with a Drizzle-like tx that returns the provided rows from any .select() call.
 *
 * The stub intercepts the fluent Drizzle chain (.select().from().leftJoin()...limit())
 * by returning `this` from each chaining method and resolving to `rows` at .limit().
 */
function makeFakeTenantRunner(rows: FakeRow[]): TenantRunner {
  return async (_tenantId, run) => {
    // Build a minimal Drizzle-like query builder that always resolves to `rows`.
    const chainable: Record<string, unknown> = {};
    const methods = ['select', 'from', 'leftJoin', 'orderBy', 'limit'];
    for (const m of methods) {
      chainable[m] = () => chainable;
    }
    // The terminal method (limit) must return a Promise resolving to rows.
    chainable.limit = () => Promise.resolve(rows);

    // Run the repository code with our fake tx.
    return run(chainable as Parameters<typeof run>[0]);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listMessages — direction field in DTO', () => {
  it('returns direction: "outbound" for a row with direction outbound', async () => {
    const fakeRows: FakeRow[] = [
      {
        wamid: 'wamid-out-1',
        name: 'Test User',
        phone: '+51987654321',
        text: 'Hello from outbound',
        type: 'text',
        receivedAt: new Date('2026-06-25T10:00:00.000Z'),
        direction: 'outbound',
      },
    ];

    const withTenant = makeFakeTenantRunner(fakeRows);
    const results: MessageDTO[] = await listMessages(withTenant, 'tenant-uuid-1');

    expect(results).toHaveLength(1);
    expect(results[0]?.direction).toBe('outbound');
  });

  it('returns direction: "inbound" for a row with direction inbound', async () => {
    const fakeRows: FakeRow[] = [
      {
        wamid: 'wamid-in-1',
        name: null,
        phone: '+51987654322',
        text: 'Hello from inbound',
        type: 'text',
        receivedAt: new Date('2026-06-25T11:00:00.000Z'),
        direction: 'inbound',
      },
    ];

    const withTenant = makeFakeTenantRunner(fakeRows);
    const results: MessageDTO[] = await listMessages(withTenant, 'tenant-uuid-1');

    expect(results).toHaveLength(1);
    expect(results[0]?.direction).toBe('inbound');
  });

  it('returns direction on all rows in a mixed list', async () => {
    const fakeRows: FakeRow[] = [
      {
        wamid: 'wamid-out-2',
        name: 'Alice',
        phone: '+51911111111',
        text: 'outbound text',
        type: 'text',
        receivedAt: new Date('2026-06-25T12:00:00.000Z'),
        direction: 'outbound',
      },
      {
        wamid: 'wamid-in-2',
        name: 'Bob',
        phone: '+51922222222',
        text: 'inbound text',
        type: 'text',
        receivedAt: new Date('2026-06-25T11:30:00.000Z'),
        direction: 'inbound',
      },
    ];

    const withTenant = makeFakeTenantRunner(fakeRows);
    const results: MessageDTO[] = await listMessages(withTenant, 'tenant-uuid-1');

    expect(results).toHaveLength(2);
    expect(results[0]?.direction).toBe('outbound');
    expect(results[1]?.direction).toBe('inbound');
  });

  it('preserves all existing DTO fields alongside direction', async () => {
    const receivedAt = new Date('2026-06-25T09:00:00.000Z');
    const fakeRows: FakeRow[] = [
      {
        wamid: 'wamid-check-1',
        name: 'Check User',
        phone: '+51933333333',
        text: 'Check text',
        type: 'text',
        receivedAt,
        direction: 'inbound',
      },
    ];

    const withTenant = makeFakeTenantRunner(fakeRows);
    const results: MessageDTO[] = await listMessages(withTenant, 'tenant-uuid-1');
    const dto = results[0];

    expect(dto).toBeDefined();
    expect(dto?.wamid).toBe('wamid-check-1');
    expect(dto?.name).toBe('Check User');
    expect(dto?.phone).toBe('+51933333333');
    expect(dto?.text).toBe('Check text');
    expect(dto?.type).toBe('text');
    expect(dto?.receivedAt).toBe(receivedAt.toISOString());
    expect(dto?.direction).toBe('inbound');
  });
});
