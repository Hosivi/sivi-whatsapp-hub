/**
 * whatsapp-send.service.test.ts — Unit tests for sendWhatsappText service.
 *
 * Pure Vitest — no Testcontainers, no real DB. Uses in-memory stubs for
 * withTenant (TenantRunner) and createFakeMetaClient for Meta egress.
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AppDeps } from '../../src/app.js';
import type { TenantRunner } from '../../src/db/client.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import { err, ok } from '../../src/shared/result.js';
import {
  resolveActiveAccount,
  sendWhatsappText,
} from '../../src/whatsapp-send/whatsapp-send.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fake TenantRunner that executes the callback with a given set of rows
 * for the account query. The rows are consumed in order; by default it returns
 * the passed rows as if they were the result of SELECT on whatsapp_accounts.
 *
 * For the service tests, we need the runner to make resolveActiveAccount work:
 * it will SELECT from whatsapp_accounts inside withTenant. We intercept by
 * providing a fully fake tx that returns the desired rows.
 */
function makeAccountStub(
  rows: Array<{ phone_number_id: string; access_token: string | null }>,
  throwOnWrite = false,
): { withTenant: TenantRunner; writeCallCount: number } {
  const state = { writeCallCount: 0 };

  const withTenant: TenantRunner = async (_tenantId, run) => {
    // Build a fake tx that returns rows for execute() calls
    const fakeTx = {
      execute: vi.fn().mockResolvedValue(rows),
    } as unknown as PostgresJsDatabase;

    if (throwOnWrite) {
      // For write tx simulation, the second call to withTenant should throw
      state.writeCallCount++;
      if (state.writeCallCount > 1) {
        throw new Error('Simulated DB write failure');
      }
    }

    return run(fakeTx);
  };

  return { withTenant, writeCallCount: state.writeCallCount };
}

/**
 * Creates a full fake AppDeps with configurable account rows and meta client.
 */
function makeDeps(
  accountRows: Array<{ phone_number_id: string; access_token: string | null }>,
  meta = createFakeMetaClient(),
  throwOnWrite = false,
): AppDeps {
  const { withTenant } = makeAccountStub(accountRows, throwOnWrite);
  return {
    db: {
      withTenant,
      adminSql: {} as never,
      resolveTenant: async () => ok(''),
      close: async () => {},
    },
    env: {
      DATABASE_URL: '',
      DATABASE_ADMIN_URL: '',
      AUTH_MODE: 'dev-header',
      PORT: 3001,
      LOG_LEVEL: 'silent',
      WHATSAPP_VERIFY_TOKEN: '',
      WHATSAPP_APP_SECRET: '',
      DATABASE_WEBHOOK_URL: '',
      ENABLE_DEV_ENDPOINTS: false,
      WHATSAPP_META_API_VERSION: 'v21.0',
    },
    meta,
  };
}

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SEND_INPUT = { to: '+51987654321', text: 'Hola' };

// ---------------------------------------------------------------------------
// resolveActiveAccount unit tests
// ---------------------------------------------------------------------------

describe('resolveActiveAccount', () => {
  it('0 rows → err({ code: "NO_ACTIVE_ACCOUNT" })', async () => {
    const { withTenant } = makeAccountStub([]);
    const result = await resolveActiveAccount(withTenant, TENANT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_ACTIVE_ACCOUNT');
  });

  it('2 rows → err({ code: "NO_ACTIVE_ACCOUNT" })', async () => {
    const { withTenant } = makeAccountStub([
      { phone_number_id: 'p1', access_token: 'tok1' },
      { phone_number_id: 'p2', access_token: 'tok2' },
    ]);
    const result = await resolveActiveAccount(withTenant, TENANT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_ACTIVE_ACCOUNT');
  });

  it('1 row with access_token = null → err({ code: "OUTBOUND_NOT_CONFIGURED" })', async () => {
    const { withTenant } = makeAccountStub([{ phone_number_id: 'p1', access_token: null }]);
    const result = await resolveActiveAccount(withTenant, TENANT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OUTBOUND_NOT_CONFIGURED');
  });

  it('1 row with access_token set → ok({ phoneNumberId, accessToken })', async () => {
    const { withTenant } = makeAccountStub([{ phone_number_id: 'pnid-1', access_token: 'my-tok' }]);
    const result = await resolveActiveAccount(withTenant, TENANT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phoneNumberId).toBe('pnid-1');
      expect(result.value.accessToken).toBe('my-tok');
    }
  });
});

// ---------------------------------------------------------------------------
// sendWhatsappText: Meta NOT called on early errors
// ---------------------------------------------------------------------------

describe('sendWhatsappText: Meta not called on account errors', () => {
  it('0 active accounts → returns NO_ACTIVE_ACCOUNT, meta not called', async () => {
    const meta = createFakeMetaClient();
    const deps = makeDeps([], meta);
    const result = await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_ACTIVE_ACCOUNT');
    expect(meta.calls).toHaveLength(0);
  });

  it('2 active accounts → returns NO_ACTIVE_ACCOUNT, meta not called', async () => {
    const meta = createFakeMetaClient();
    const deps = makeDeps(
      [
        { phone_number_id: 'p1', access_token: 'tok1' },
        { phone_number_id: 'p2', access_token: 'tok2' },
      ],
      meta,
    );
    const result = await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_ACTIVE_ACCOUNT');
    expect(meta.calls).toHaveLength(0);
  });

  it('NULL token → returns OUTBOUND_NOT_CONFIGURED, meta not called', async () => {
    const meta = createFakeMetaClient();
    const deps = makeDeps([{ phone_number_id: 'p1', access_token: null }], meta);
    const result = await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OUTBOUND_NOT_CONFIGURED');
    expect(meta.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sendWhatsappText: Meta invocation
// ---------------------------------------------------------------------------

describe('sendWhatsappText: Meta invocation', () => {
  it('valid account → meta.sendText called ONCE with correct args', async () => {
    const meta = createFakeMetaClient();
    const deps = makeDeps([{ phone_number_id: 'pnid-1', access_token: 'tok-abc' }], meta);
    await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]?.phoneNumberId).toBe('pnid-1');
    expect(meta.calls[0]?.accessToken).toBe('tok-abc');
    expect(meta.calls[0]?.to).toBe(SEND_INPUT.to);
    expect(meta.calls[0]?.text).toBe(SEND_INPUT.text);
  });

  it('fake.calls[0].accessToken matches account row accessToken', async () => {
    const accountToken = 'secret-token-xyz';
    const meta = createFakeMetaClient();
    const deps = makeDeps([{ phone_number_id: 'pnid-1', access_token: accountToken }], meta);
    await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(meta.calls[0]?.accessToken).toBe(accountToken);
  });
});

// ---------------------------------------------------------------------------
// sendWhatsappText: Meta error mapping
// ---------------------------------------------------------------------------

describe('sendWhatsappText: Meta error mapping', () => {
  it('Meta 131047 → err({ code: "WINDOW_CLOSED" })', async () => {
    const meta = createFakeMetaClient();
    meta.queueError({ code: 'META_API_ERROR', metaCode: 131047 });
    const deps = makeDeps([{ phone_number_id: 'p1', access_token: 'tok' }], meta);
    const result = await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WINDOW_CLOSED');
  });

  it('Meta 190 → err({ code: "META_API_ERROR" })', async () => {
    const meta = createFakeMetaClient();
    meta.queueError({ code: 'META_API_ERROR', metaCode: 190 });
    const deps = makeDeps([{ phone_number_id: 'p1', access_token: 'tok' }], meta);
    const result = await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('META_API_ERROR');
  });

  it('NETWORK_ERROR → err({ code: "NETWORK_ERROR" })', async () => {
    const meta = createFakeMetaClient();
    meta.queueError({ code: 'NETWORK_ERROR' });
    const deps = makeDeps([{ phone_number_id: 'p1', access_token: 'tok' }], meta);
    const result = await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
// sendWhatsappText: success path
// ---------------------------------------------------------------------------

describe('sendWhatsappText: success path', () => {
  it('valid account + Meta ok → ok({ wamid, status })', async () => {
    const meta = createFakeMetaClient();

    // Two-call withTenant: first is the account read, second is the write tx.
    let callCount = 0;
    const withTenant: TenantRunner = async (_tenantId, run) => {
      callCount++;
      if (callCount === 1) {
        // Account read tx: return one active row via execute()
        const fakeTx = {
          execute: vi.fn().mockResolvedValue([{ phone_number_id: 'p1', access_token: 'tok' }]),
        } as unknown as PostgresJsDatabase;
        return run(fakeTx);
      }
      // Write tx: simulate successful write — upsertContactTx + INSERT succeed.
      // We mock all Drizzle query builder methods needed by upsertContactTx.
      const fakeContact = {
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        tenantId: TENANT_ID,
        phoneE164: SEND_INPUT.to,
        fullName: null,
        source: 'whatsapp',
        tags: [],
        intent: null,
        intentConfidence: null,
        routedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]), // no existing contact → INSERT
          }),
        }),
      });
      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fakeContact]),
        }),
      });
      const mockExecute = vi.fn().mockResolvedValue([]);
      const fakeTx = {
        select: mockSelect,
        insert: mockInsert,
        execute: mockExecute,
      } as unknown as PostgresJsDatabase;
      return run(fakeTx);
    };

    const deps: AppDeps = {
      db: {
        withTenant,
        adminSql: {} as never,
        resolveTenant: async () => ok(''),
        close: async () => {},
      },
      env: {
        DATABASE_URL: '',
        DATABASE_ADMIN_URL: '',
        AUTH_MODE: 'dev-header',
        PORT: 3001,
        LOG_LEVEL: 'silent',
        WHATSAPP_VERIFY_TOKEN: '',
        WHATSAPP_APP_SECRET: '',
        DATABASE_WEBHOOK_URL: '',
        ENABLE_DEV_ENDPOINTS: false,
        WHATSAPP_META_API_VERSION: 'v21.0',
      },
      meta,
    };

    const result = await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wamid).toBe('wamid-fake-1');
      expect(result.value.status).toBe('accepted');
    }
  });
});

// ---------------------------------------------------------------------------
// sendWhatsappText: DB_ERROR path
// ---------------------------------------------------------------------------

describe('sendWhatsappText: DB_ERROR path', () => {
  it('Meta ok + write tx throws → err({ code: "DB_ERROR" })', async () => {
    const meta = createFakeMetaClient();

    // Fake withTenant: first call (account read) succeeds with one row,
    // second call (write tx) throws to simulate DB write failure.
    let callCount = 0;
    const withTenant: TenantRunner = async (_tenantId, run) => {
      callCount++;
      if (callCount === 1) {
        // Account read: return one active row
        const fakeTx = {
          execute: vi.fn().mockResolvedValue([{ phone_number_id: 'p1', access_token: 'tok' }]),
        } as unknown as PostgresJsDatabase;
        return run(fakeTx);
      }
      // Write tx: throw to simulate DB failure
      throw new Error('DB connection lost');
    };

    const deps: AppDeps = {
      db: {
        withTenant,
        adminSql: {} as never,
        resolveTenant: async () => ok(''),
        close: async () => {},
      },
      env: {
        DATABASE_URL: '',
        DATABASE_ADMIN_URL: '',
        AUTH_MODE: 'dev-header',
        PORT: 3001,
        LOG_LEVEL: 'silent',
        WHATSAPP_VERIFY_TOKEN: '',
        WHATSAPP_APP_SECRET: '',
        DATABASE_WEBHOOK_URL: '',
        ENABLE_DEV_ENDPOINTS: false,
        WHATSAPP_META_API_VERSION: 'v21.0',
      },
      meta,
    };

    const result = await sendWhatsappText(deps, TENANT_ID, SEND_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DB_ERROR');
  });
});
