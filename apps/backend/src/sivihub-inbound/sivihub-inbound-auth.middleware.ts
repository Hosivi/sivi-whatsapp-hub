/**
 * sivihub-inbound-auth.middleware.ts — S1: service authentication for
 * SiviHub-originated requests (ADR-0048 corte 4).
 *
 * Reads the raw body ONCE, before any JSON parsing (mirrors the Meta webhook's
 * arrayBuffer-first pattern in webhooks/whatsapp.route.ts — Hono only lets the
 * body stream be consumed once). Identifies the link from the X-Sivi-Link-Id
 * header, resolves it via the app_webhook (cross-tenant, column-scoped) handle,
 * decrypts its secret, and verifies the HMAC-SHA256 signature + ±300s freshness
 * window (verifySivihubSignature).
 *
 * CRITICAL: the tenant is set from the LINK ROW (link.tenantId), never from any
 * header the caller controls. Only an `active` link authenticates.
 *
 * Every failure — an unparseable/unknown link id, a revoked link, a bad
 * signature, or a stale timestamp — answers the IDENTICAL
 * 401 { error: 'unauthorized' }. No distinguishing detail is ever leaked.
 *
 * On success, sets `tenantId` the SAME way tenant.middleware.ts does (c.set),
 * so the RLS transaction shape downstream (deps.db.withTenant(tenantId, ...))
 * is unchanged — and stashes the already-consumed raw body under
 * `sivihubRawBody` so the route handler can parse it without re-reading the
 * (already-drained) request stream.
 */

import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import {
  SIVIHUB_LINK_ID_HEADER,
  SIVIHUB_SIGNATURE_HEADER,
  SIVIHUB_TIMESTAMP_HEADER,
  verifySivihubSignature,
} from './sivihub-inbound-signature.js';

export type SivihubInboundVariables = {
  tenantId: string;
  sivihubRawBody: string;
};

const linkIdSchema = z.string().uuid();

/**
 * Creates the S1 middleware. Mount it on the SiviHub-facing sub-router in place
 * of createTenantMiddleware — this route family has NO X-Tenant-Id header at all.
 */
export const createSivihubInboundAuthMiddleware = (
  deps: AppDeps,
): MiddlewareHandler<{ Variables: SivihubInboundVariables }> => {
  return async (c, next) => {
    const unauthorized = () => c.json({ error: 'unauthorized' }, 401);

    const linkIdHeader = c.req.header(SIVIHUB_LINK_ID_HEADER);
    const linkIdParsed = linkIdHeader ? linkIdSchema.safeParse(linkIdHeader) : null;
    if (!linkIdParsed || !linkIdParsed.success) {
      return unauthorized();
    }
    const linkId = linkIdParsed.data;

    // MUST read raw body BEFORE any c.req.json() — Hono consumes the stream once.
    const rawBodyBuffer = await c.req.arrayBuffer();
    const rawBody = Buffer.from(rawBodyBuffer).toString('utf8');

    // Resolve the link (and its tenant) BEFORE trusting anything else — the
    // tenant comes from THIS row, never from a header. Cross-tenant lookup via
    // the app_webhook role (mirrors resolveTenant for phone_number_id).
    const linkResult = await deps.db.resolveSivihubLink(linkId);
    if (!linkResult.ok) {
      return unauthorized();
    }
    const link = linkResult.value;

    // Decrypt the channel secret only here — NEVER logged.
    const secretHex = deps.sivihubLinkCipher.decrypt(link.secretEncrypted);
    if (secretHex === null) {
      return unauthorized();
    }

    const signatureOk = verifySivihubSignature({
      secretHex,
      rawBody,
      timestampHeader: c.req.header(SIVIHUB_TIMESTAMP_HEADER),
      signatureHeader: c.req.header(SIVIHUB_SIGNATURE_HEADER),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!signatureOk) {
      return unauthorized();
    }

    // Tenant comes from the link row, never from the request — set the SAME way
    // tenant.middleware.ts does, so the downstream RLS transaction shape
    // (deps.db.withTenant(tenantId, ...)) is unchanged.
    c.set('tenantId', link.tenantId);
    c.set('sivihubRawBody', rawBody);
    await next();
    return;
  };
};
