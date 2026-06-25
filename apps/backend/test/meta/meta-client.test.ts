/**
 * meta-client.test.ts — Unit tests for createFakeMetaClient.
 *
 * Pure Vitest — no network, no DB, no Testcontainers.
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import type { MetaClient } from '../../src/meta/meta-client.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { err, ok } from '../../src/shared/result.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createFakeMetaClient', () => {
  it('returns ok({ wamid: "wamid-fake-1", status: "accepted" }) by default', async () => {
    const fake = createFakeMetaClient();
    const result = await fake.sendText({
      phoneNumberId: 'pnid-1',
      accessToken: 'tok',
      to: '+51987654321',
      text: 'Hola',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wamid).toBe('wamid-fake-1');
      expect(result.value.status).toBe('accepted');
    }
  });

  it('returns err with META_API_ERROR when queueError is called with metaCode 131047', async () => {
    const fake = createFakeMetaClient();
    fake.queueError({ code: 'META_API_ERROR', metaCode: 131047 });

    const result = await fake.sendText({
      phoneNumberId: 'pnid-1',
      accessToken: 'tok',
      to: '+51987654321',
      text: 'Hola',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('META_API_ERROR');
      if (result.error.code === 'META_API_ERROR') {
        expect(result.error.metaCode).toBe(131047);
      }
    }
  });

  it('records calls in fake.calls after sendText is invoked', async () => {
    const fake = createFakeMetaClient();
    const input = {
      phoneNumberId: 'pnid-1',
      accessToken: 'secret-tok',
      to: '+51987654321',
      text: 'Hola mundo',
    };

    await fake.sendText(input);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual(input);
  });

  it('satisfies the MetaClient type (TypeScript compilation test)', () => {
    const fake = createFakeMetaClient();
    // If this compiles, the fake satisfies MetaClient.
    const _: MetaClient = fake;
    expect(_).toBeDefined();
  });

  it('does not make any real network request (fake never calls fetch)', async () => {
    // The fake is a pure in-memory object — it has no fetch implementation.
    // We verify this by checking the fake's sendText function source does not reference fetch.
    const fake = createFakeMetaClient();
    const fnSource = fake.sendText.toString();
    expect(fnSource).not.toContain('fetch(');
  });
});
