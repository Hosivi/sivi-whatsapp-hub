/**
 * dialog360-client.test.ts — Unit tests for createDialog360Client.
 *
 * Pure Vitest — no network, no DB, no Testcontainers. The real
 * createDialog360Client is exercised with a stubbed global fetch
 * (vi.stubGlobal).
 *
 * STRICT TDD MODE — tests written RED before implementation.
 *
 * Key behavioral differences from createMetaClient:
 *   - URL = `${baseUrl}/messages` — NO phoneNumberId in path
 *   - Auth header = `D360-API-KEY: <token>` — NOT Bearer
 *   - Request body + success response shape are IDENTICAL to Meta
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDialog360Client } from '../../src/meta/dialog360-client.js';
import type { MetaClient } from '../../src/meta/meta-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SANDBOX_BASE_URL = 'https://waba-sandbox.360dialog.io/v1';

const INPUT = {
  phoneNumberId: 'pnid-irrelevant', // 360dialog ignores this for the URL
  accessToken: 'd360-api-key-secret',
  to: '+51987654321',
  text: 'Hola 360dialog',
};

/** Builds a minimal Response-like stub honouring ok/status/text(). */
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createDialog360Client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---- (a) Success --------------------------------------------------------

  it('(a) 2xx with messages[0].id → ok({ wamid, status })', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({
          messages: [{ id: 'wamid-360-1', message_status: 'accepted' }],
        }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wamid).toBe('wamid-360-1');
      expect(result.value.status).toBe('accepted');
    }
  });

  // ---- (b) URL shape — no phoneNumberId in path ---------------------------

  it('(b) URL is `${baseUrl}/messages` with NO phoneNumberId in path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({ messages: [{ id: 'wamid-360-2' }] }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    await client.sendText(INPUT);

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe(`${SANDBOX_BASE_URL}/messages`);
    expect(url).not.toContain(INPUT.phoneNumberId);
  });

  // ---- (c) Auth header — D360-API-KEY -------------------------------------

  it('(c) sends D360-API-KEY header (NOT Authorization: Bearer)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({ messages: [{ id: 'wamid-360-3' }] }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    await client.sendText(INPUT);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(headers['d360-api-key']).toBe(INPUT.accessToken);
    expect(JSON.stringify(headers)).not.toContain('bearer');
    expect(JSON.stringify(headers)).not.toContain('Bearer');
    expect(JSON.stringify(headers)).not.toContain('Authorization');
    expect(JSON.stringify(headers)).not.toContain('authorization');
  });

  // ---- (d) Body shape — identical to Meta Cloud API -----------------------

  it('(d) body matches WhatsApp Cloud API format (messaging_product, recipient_type, to, type, text)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({ messages: [{ id: 'wamid-360-4' }] }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    await client.sendText(INPUT);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);

    expect(sentBody.messaging_product).toBe('whatsapp');
    expect(sentBody.recipient_type).toBe('individual');
    expect(sentBody.to).toBe(INPUT.to);
    expect(sentBody.type).toBe('text');
    expect(sentBody.text.body).toBe(INPUT.text);
  });

  // ---- (e) non-2xx → META_API_ERROR ---------------------------------------

  it('(e) non-2xx JSON error → META_API_ERROR carrying metaCode', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 400,
        body: JSON.stringify({ error: { code: 190, message: 'Invalid API key' } }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('META_API_ERROR');
      if (result.error.code === 'META_API_ERROR') {
        expect(result.error.metaCode).toBe(190);
      }
    }
  });

  // ---- (f) fetch throws → NETWORK_ERROR -----------------------------------

  it('(f) fetch rejects → NETWORK_ERROR and NEVER throws to caller', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NETWORK_ERROR');
  });

  // ---- (g) 131047 → maps to WINDOW_CLOSED metaCode ------------------------

  it('(g) non-2xx with error.code 131047 → META_API_ERROR metaCode 131047', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 400,
        body: JSON.stringify({
          error: { code: 131047, message: 'Recipient phone not in 24h window' },
        }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'META_API_ERROR') {
      expect(result.error.metaCode).toBe(131047);
    }
  });

  // ---- (h) D360-API-KEY NEVER leaks into errors ---------------------------

  it('(h) D360-API-KEY NEVER appears in the returned error (non-2xx)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 401,
        body: JSON.stringify({ error: { code: 401, message: 'Unauthorized' } }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result.error);
      expect(serialized).not.toContain(INPUT.accessToken);
    }
  });

  it('(h2) D360-API-KEY NEVER appears in NETWORK_ERROR cause', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('transport failure'));
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
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

  // ---- (i) non-2xx non-JSON body ------------------------------------------

  it('(i) non-2xx non-JSON body → META_API_ERROR with metaCode = HTTP status', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 503, body: '<html>Bad Gateway</html>' }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('META_API_ERROR');
      if (result.error.code === 'META_API_ERROR') {
        expect(result.error.metaCode).toBe(503);
      }
    }
  });

  // ---- (j) 2xx missing wamid ----------------------------------------------

  it('(j) 2xx but missing wamid → META_API_ERROR', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, body: JSON.stringify({ messages: [{}] }) }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(SANDBOX_BASE_URL);
    const result = await client.sendText(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('META_API_ERROR');
  });

  // ---- (k) satisfies MetaClient interface ---------------------------------

  it('(k) satisfies the MetaClient contract (TypeScript compilation test)', () => {
    const client = createDialog360Client(SANDBOX_BASE_URL);
    const _: MetaClient = client;
    expect(_).toBeDefined();
  });

  // ---- (l) production base URL works too ----------------------------------

  it('(l) uses the production base URL when configured', async () => {
    const PROD_BASE_URL = 'https://waba-v2.360dialog.io';
    const fetchSpy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({ messages: [{ id: 'wamid-360-prod' }] }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = createDialog360Client(PROD_BASE_URL);
    await client.sendText(INPUT);

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe(`${PROD_BASE_URL}/messages`);
  });
});
