/**
 * tenant.middleware.ts — Tenant identification middleware.
 *
 * In AUTH_MODE=dev-header:
 *   - Missing or empty X-Tenant-Id → 401 { "error": "MISSING_TENANT" }
 *   - Present but not a valid UUID → 400 { "error": "INVALID_TENANT_ID" }
 *   - Valid UUID → c.set('tenantId', id); next()
 *
 * In AUTH_MODE=jwt:
 *   - 501 stub (not yet implemented)
 *
 * The middleware is attached to all domain routes (/contacts, etc.).
 * It MUST NOT be attached to /health.
 *
 * JWT-swap isolation: all tenant-source knowledge lives here. Switching from
 * dev-header to JWT only touches this one file; repositories and routes are unaffected.
 */

import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Env } from '../config/env.js';

const uuidSchema = z.string().uuid();

export const createTenantMiddleware = (env: Env): MiddlewareHandler => {
  if (env.AUTH_MODE === 'dev-header') {
    return async (c, next) => {
      const header = c.req.header('X-Tenant-Id');

      if (!header || header.trim() === '') {
        return c.json({ error: 'MISSING_TENANT' }, 401);
      }

      const parsed = uuidSchema.safeParse(header);
      if (!parsed.success) {
        return c.json({ error: 'INVALID_TENANT_ID' }, 400);
      }

      c.set('tenantId' as string, parsed.data);
      await next();
      return;
    };
  }

  // AUTH_MODE === 'jwt' — stub until JWT is implemented
  return async (c, _next) => {
    return c.json({ error: 'JWT_AUTH_NOT_IMPLEMENTED' }, 501);
  };
};
