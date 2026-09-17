/**
 * sivihub-inbound-auth.middleware.int.test.ts — Integration tests for S1, the
 * SiviHub-originated service-auth middleware (ADR-0048 corte 4).
 *
 * Mounts createSivihubInboundAuthMiddleware DIRECTLY on a throwaway Hono app
 * (not buildApp / /sivihub/messages) — S1 authenticates and resolves a tenant;
 * it has no business logic and no dependency on S2's send route. A trivial
 * POST handler behind it echoes c.get('tenantId') so tests can assert exactly
 * what S1 resolved, decoupled from whatever route S2 later mounts it under.
 *
 * Uses Testcontainers (PG16) for the real app_webhook cross-tenant lookup +
 * the real cipher, so this exercises the full S1 stack: raw-body read →
 * resolveSivihubLink (app_webhook) → cipher decrypt → HMAC verify →
 * c.set('tenantId', ...) → next().
 *
 * STRICT TDD MODE — written RED before implementation.
 */

import { Hono } from 'hono';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { createDbClient } from '../../src/db/client.js';
import { createFakeMetaClient } from '../../src/meta/meta-client.js';
import type { SivihubInboundVariables } from '../../src/sivihub-inbound/sivihub-inbound-auth.middleware.js';
import { createSivihubInboundAuthMiddleware } from '../../src/sivihub-inbound/sivihub-inbound-auth.middleware.js';
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
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const KEY_HEX = 'c'.repeat(64);
const SECRET_A_HEX = 'd'.repeat(64);
const SECRET_B_HEX = 'e'.repeat(64);

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

function signedHeaders(
  linkId: string,
  secretHex: string,
  rawBody: string,
  timestampSeconds: number,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    [SIVIHUB_LINK_ID_HEADER]: linkId,
    [SIVIHUB_TIMESTAMP_HEADER]: String(timestampSeconds),
    [SIVIHUB_SIGNATURE_HEADER]: signSivihubEvent(secretHex, rawBody, timestampSeconds),
  };
}

describe('SiviHub inbound auth (S1) — standalone middleware', () => {
  let db: TestDb;
  let app: Hono<{ Variables: SivihubInboundVariables }>;
  const cipher = createSivihubLinkSecretCipher(KEY_HEX);

  beforeAll(async () => {
    db = await createTestDb();

    // Minimal deps — the middleware touches ONLY deps.db and deps.sivihubLinkCipher;
    // env/meta/llm/logger are never read by it, so unused-but-required AppDeps
    // fields are filled with inert stand-ins (mirrors the house convention of
    // partial AppDeps stubs in whatsapp-send.service.test.ts).
    const deps = {
      db,
      env: makeEnv(),
      meta: createFakeMetaClient(),
      sivihubLinkCipher: cipher,
    } as unknown as AppDeps;

    app = new Hono<{ Variables: SivihubInboundVariables }>();
    app.use('*', createSivihubInboundAuthMiddleware(deps));
    // Trivial handler: echoes exactly what S1 resolved — proves the tenant
    // came from the link row, not from any header.
    app.post('/', (c) => c.json({ tenantId: c.get('tenantId') }, 200));
  });

  beforeEach(async () => {
    await db.truncate();
  });

  afterAll(async () => {
    await db.teardown();
  });

  async function seedLink(tenantId: string, secretHex: string, status: 'active' | 'revoked') {
    const { id } = await db.withTenant(tenantId, (tx) =>
      storeOrReplaceActiveLink(tx, tenantId, 'https://sivihub.pe/hooks', cipher.encrypt(secretHex)),
    );
    if (status === 'revoked') {
      await db.adminSql`UPDATE sivihub_links SET status = 'revoked' WHERE id = ${id}::uuid`;
    }
    return id;
  }

  it('(a) correctly signed request → passes S1, tenantId is the LINK tenant (200)', async () => {
    const linkId = await seedLink(TENANT_A, SECRET_A_HEX, 'active');
    const rawBody = JSON.stringify({ to: '+51987654321', text: 'Hola' });
    const nowSeconds = Math.floor(Date.now() / 1000);

    const res = await app.request('/', {
      method: 'POST',
      headers: signedHeaders(linkId, SECRET_A_HEX, rawBody, nowSeconds),
      body: rawBody,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(TENANT_A);
  });

  it('(b) unknown link id → 401 { error: "unauthorized" }', async () => {
    const rawBody = JSON.stringify({ to: '+51987654321', text: 'Hola' });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const unknownLinkId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    const res = await app.request('/', {
      method: 'POST',
      headers: signedHeaders(unknownLinkId, SECRET_A_HEX, rawBody, nowSeconds),
      body: rawBody,
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('(c) wrong signature (right link, wrong secret) → identical 401', async () => {
    const linkId = await seedLink(TENANT_A, SECRET_A_HEX, 'active');
    const rawBody = JSON.stringify({ to: '+51987654321', text: 'Hola' });
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Signed with SECRET_B_HEX, not the link's actual secret (SECRET_A_HEX).
    const res = await app.request('/', {
      method: 'POST',
      headers: signedHeaders(linkId, SECRET_B_HEX, rawBody, nowSeconds),
      body: rawBody,
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('(d) stale timestamp (301s old) → identical 401', async () => {
    const linkId = await seedLink(TENANT_A, SECRET_A_HEX, 'active');
    const rawBody = JSON.stringify({ to: '+51987654321', text: 'Hola' });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 301;

    const res = await app.request('/', {
      method: 'POST',
      headers: signedHeaders(linkId, SECRET_A_HEX, rawBody, staleTimestamp),
      body: rawBody,
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('(e) revoked link → identical 401 (only an active link authenticates)', async () => {
    const linkId = await seedLink(TENANT_A, SECRET_A_HEX, 'revoked');
    const rawBody = JSON.stringify({ to: '+51987654321', text: 'Hola' });
    const nowSeconds = Math.floor(Date.now() / 1000);

    const res = await app.request('/', {
      method: 'POST',
      headers: signedHeaders(linkId, SECRET_A_HEX, rawBody, nowSeconds),
      body: rawBody,
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('(f) missing signature headers entirely → 401, never reaches the handler', async () => {
    const rawBody = JSON.stringify({ to: '+51987654321', text: 'Hola' });

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('(g) a request signed with tenant B link resolves tenant B, never tenant A', async () => {
    const linkA = await seedLink(TENANT_A, SECRET_A_HEX, 'active');
    const linkB = await seedLink(TENANT_B, SECRET_B_HEX, 'active');
    expect(linkA).not.toBe(linkB);

    const rawBody = JSON.stringify({ to: '+51987654321', text: 'Hola' });
    const nowSeconds = Math.floor(Date.now() / 1000);

    const res = await app.request('/', {
      method: 'POST',
      headers: signedHeaders(linkB, SECRET_B_HEX, rawBody, nowSeconds),
      body: rawBody,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(TENANT_B);
    expect(body.tenantId).not.toBe(TENANT_A);
  });

  it('(h) malformed (non-UUID) link id header → 401, never queries the DB with it', async () => {
    const rawBody = JSON.stringify({ to: '+51987654321', text: 'Hola' });
    const nowSeconds = Math.floor(Date.now() / 1000);

    const res = await app.request('/', {
      method: 'POST',
      headers: signedHeaders('not-a-uuid', SECRET_A_HEX, rawBody, nowSeconds),
      body: rawBody,
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });
});

// ---------------------------------------------------------------------------
// Infrastructure failure — a DB outage must be logged, not silently
// indistinguishable from "everything is unauthorized" (ADR-0048 corte 4
// correction). Uses a REAL createDbClient (not the Testcontainers-backed
// TestDb mirror) pointed at a connection that is refused immediately — no
// container needed to simulate "Postgres is down".
// ---------------------------------------------------------------------------

describe('SiviHub inbound auth (S1) — database outage (real createDbClient, no Testcontainers)', () => {
  it('a thrown DB error while resolving the link is logged at error level (no secret/full link id/message body) and the request still gets 401', async () => {
    const logCalls: unknown[][] = [];
    const fakeLogger = {
      error: (...args: unknown[]) => {
        logCalls.push(args);
      },
    } as unknown as Logger;

    const outageEnv = makeEnv({
      // No listener on this port — connection is refused immediately, which
      // simulates "Postgres is down" without stopping a real container mid-test.
      DATABASE_WEBHOOK_URL: 'postgresql://baduser:badpass@127.0.0.1:1/nonexistent',
    });

    const db = createDbClient(outageEnv, fakeLogger);
    const cipher = createSivihubLinkSecretCipher('c'.repeat(64));
    const deps = {
      db,
      env: outageEnv,
      meta: createFakeMetaClient(),
      sivihubLinkCipher: cipher,
    } as unknown as AppDeps;

    const app = new Hono<{ Variables: SivihubInboundVariables }>();
    app.use('*', createSivihubInboundAuthMiddleware(deps));
    app.post('/', (c) => c.json({ tenantId: c.get('tenantId') }, 200));

    // Syntactically valid UUID (passes S1's Zod check) — its existence is
    // never actually resolved because the DB call throws first.
    const linkId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const rawBody = JSON.stringify({ to: '+51987654321', text: 'a private customer message' });
    const nowSeconds = Math.floor(Date.now() / 1000);

    try {
      const res = await app.request('/', {
        method: 'POST',
        headers: signedHeaders(linkId, SECRET_A_HEX, rawBody, nowSeconds),
        body: rawBody,
      });

      // Same 401 as any other auth failure — the caller learns nothing.
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'unauthorized' });

      // But the OPERATOR must see it: an outage must not be silent.
      expect(logCalls.length).toBeGreaterThanOrEqual(1);
      const loggedText = JSON.stringify(logCalls);
      expect(loggedText).not.toContain(linkId);
      expect(loggedText).not.toContain('a private customer message');
      expect(loggedText.toLowerCase()).not.toContain(SECRET_A_HEX.toLowerCase());
    } finally {
      await db.close();
    }
  }, 15000);
});
