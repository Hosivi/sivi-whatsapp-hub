/**
 * sivihub-link.cli.test.ts — Unit tests for the `sivihub:link` CLI's pure argv
 * parser/validator and its composed run path against fake dependencies.
 *
 * Pure Vitest — no DB, no Testcontainers.
 * STRICT TDD MODE — written RED before implementation.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseLinkArgs, runLinkCommand } from '../../src/sivihub-link/sivihub-link.cli.js';

const VALID_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VALID_URL = 'https://academia-ritmo.sivihub.pe/api/hooks/ventas/tenants/x/channels/y/events';

describe('parseLinkArgs', () => {
  it('parses a fully valid argv into { tenant, eventsUrl, secret }', () => {
    const result = parseLinkArgs([
      '--tenant',
      VALID_TENANT,
      '--events-url',
      VALID_URL,
      '--secret',
      'my-secret-value',
    ]);
    expect(result).toEqual({
      tenant: VALID_TENANT,
      eventsUrl: VALID_URL,
      secret: 'my-secret-value',
    });
  });

  it('works regardless of flag order', () => {
    const result = parseLinkArgs([
      '--secret',
      'my-secret-value',
      '--events-url',
      VALID_URL,
      '--tenant',
      VALID_TENANT,
    ]);
    expect(result).toEqual({
      tenant: VALID_TENANT,
      eventsUrl: VALID_URL,
      secret: 'my-secret-value',
    });
  });

  it('reports MISSING_ARG when --tenant is absent', () => {
    const result = parseLinkArgs(['--events-url', VALID_URL, '--secret', 'x']);
    expect(result).toEqual({ code: 'MISSING_ARG', flag: 'tenant' });
  });

  it('reports MISSING_ARG when --events-url is absent', () => {
    const result = parseLinkArgs(['--tenant', VALID_TENANT, '--secret', 'x']);
    expect(result).toEqual({ code: 'MISSING_ARG', flag: 'events-url' });
  });

  it('reports MISSING_ARG when --secret is absent', () => {
    const result = parseLinkArgs(['--tenant', VALID_TENANT, '--events-url', VALID_URL]);
    expect(result).toEqual({ code: 'MISSING_ARG', flag: 'secret' });
  });

  it('reports INVALID_TENANT when --tenant is not a UUID', () => {
    const result = parseLinkArgs([
      '--tenant',
      'not-a-uuid',
      '--events-url',
      VALID_URL,
      '--secret',
      'x',
    ]);
    expect(result).toEqual({ code: 'INVALID_TENANT' });
  });

  it('reports INVALID_EVENTS_URL when --events-url fails validation (non-localhost http)', () => {
    const result = parseLinkArgs([
      '--tenant',
      VALID_TENANT,
      '--events-url',
      'http://academia-ritmo.sivihub.pe/x',
      '--secret',
      'x',
    ]);
    expect(result).toEqual({ code: 'INVALID_EVENTS_URL' });
  });
});

describe('runLinkCommand', () => {
  it('encrypts the secret and stores it via storeOrReplaceActiveLink — never the plaintext', async () => {
    const encrypt = vi.fn().mockReturnValue('v1:encrypted-payload');
    const cipher = { encrypt, decrypt: vi.fn() };

    let capturedEncrypted: string | undefined;
    const withTenant = vi.fn(async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        execute: vi.fn().mockImplementation((query: { queryChunks?: unknown[] }) => {
          const values = (query.queryChunks ?? []).filter((c) => typeof c === 'string');
          capturedEncrypted = values.find((v) => (v as string).startsWith('v1:')) as
            | string
            | undefined;
          return Promise.resolve([{ id: 'link-id-1' }]);
        }),
      };
      return run(fakeTx);
    });

    const result = await runLinkCommand(
      { tenant: VALID_TENANT, eventsUrl: VALID_URL, secret: 'plain-secret' },
      // biome-ignore lint/suspicious/noExplicitAny: test double
      { withTenant: withTenant as any, cipher: cipher as any },
    );

    expect(encrypt).toHaveBeenCalledWith('plain-secret');
    expect(result).toEqual({ id: 'link-id-1' });
    expect(withTenant).toHaveBeenCalledWith(VALID_TENANT, expect.any(Function));
    expect(capturedEncrypted).toBe('v1:encrypted-payload');
  });
});
