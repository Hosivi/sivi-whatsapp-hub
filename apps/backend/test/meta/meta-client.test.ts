/**
 * meta-client.test.ts — Unit tests for createFakeMetaClient and createMetaClient.
 *
 * Pure Vitest — no network, no DB, no Testcontainers. The real createMetaClient
 * is exercised with a stubbed global fetch (vi.stubGlobal).
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetaClient } from '../../src/meta/meta-client.js';
import { createFakeMetaClient, createMetaClient } from '../../src/meta/meta-client.js';

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
    // Stub global fetch, drive the FAKE, and assert fetch was NEVER called.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const fake = createFakeMetaClient();
      await fake.sendText({
        phoneNumberId: 'pnid-1',
        accessToken: 'tok',
        to: '+51987654321',
        text: 'Hola',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// createMetaClient (REAL fetch-based implementation)
// ---------------------------------------------------------------------------

describe('createMetaClient (real, mocked fetch)', () => {
  const API_VERSION = 'v21.0';
  const INPUT = {
    phoneNumberId: 'pnid-real-1',
    accessToken: 'super-secret-token',
    to: '+51987654321',
    text: 'Hola mundo',
  };

  /** Builds a minimal Response-like stub honoring ok/status/text(). */
  function makeResponse(opts: { status: number; body: string }): Response {
    return {
      ok: opts.status >= 200 && opts.status < 300,
      status: opts.status,
      async text() {
        return opts.body;
      },
      async json() {
        return JSON.parse(opts.body);
      },
    } as unknown as Response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('(a) 2xx with messages[0].id → ok({ wamid, status })', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({ messages: [{ id: 'wamid-real-1', message_status: 'accepted' }] }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wamid).toBe('wamid-real-1');
      expect(result.value.status).toBe('accepted');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('(b) 2xx missing wamid → META_API_ERROR', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, body: JSON.stringify({ messages: [{}] }) }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('META_API_ERROR');
  });

  it('(c) non-2xx JSON with error.code → META_API_ERROR carrying metaCode', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 400,
        body: JSON.stringify({ error: { code: 190, message: 'Invalid token' } }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('META_API_ERROR');
      if (result.error.code === 'META_API_ERROR') {
        expect(result.error.metaCode).toBe(190);
      }
    }
  });

  it('(d) non-2xx 131047 → META_API_ERROR with metaCode 131047', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 400,
        body: JSON.stringify({ error: { code: 131047, message: 'window closed' } }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'META_API_ERROR') {
      expect(result.error.metaCode).toBe(131047);
    }
  });

  it('(d-bis) non-2xx with NON-JSON body → META_API_ERROR (not NETWORK_ERROR), metaCode = HTTP status', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 503, body: '<html>Service Unavailable</html>' }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('META_API_ERROR');
      if (result.error.code === 'META_API_ERROR') {
        expect(result.error.metaCode).toBe(503);
      }
    }
  });

  it('(e) fetch rejects → NETWORK_ERROR and NEVER throws to caller', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    // Must resolve to a Result, not throw.
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NETWORK_ERROR');
  });

  it('(f) request URL contains the configured API version', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({ messages: [{ id: 'wamid-real-2' }] }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    await client.sendText(INPUT);

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain(`/${API_VERSION}/`);
    expect(url).toContain(INPUT.phoneNumberId);
  });

  it('(f2) request body includes recipient_type=individual and preview_url=false', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({ messages: [{ id: 'wamid-real-3' }] }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    await client.sendText(INPUT);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.recipient_type).toBe('individual');
    expect(sentBody.text).toEqual({ body: INPUT.text, preview_url: false });
  });

  it('(g) access_token NEVER appears in the returned error object/cause', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 401,
        body: JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result.error);
      expect(serialized).not.toContain(INPUT.accessToken);
    }
  });

  it('(g2) access_token NEVER appears in a NETWORK_ERROR cause', async () => {
    // Even if the thrown error somehow carried request context, the returned
    // error must not leak the token.
    const fetchSpy = vi.fn().mockRejectedValue(new Error('transport down'));
    vi.stubGlobal('fetch', fetchSpy);

    const client = createMetaClient(API_VERSION);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify({
        code: result.error.code,
        cause:
          result.error.code === 'NETWORK_ERROR' && result.error.cause instanceof Error
            ? result.error.cause.message
            : result.error.code === 'NETWORK_ERROR'
              ? result.error.cause
              : undefined,
      });
      expect(serialized).not.toContain(INPUT.accessToken);
    }
  });
});
