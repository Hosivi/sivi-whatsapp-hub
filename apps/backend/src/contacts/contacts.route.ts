/**
 * contacts.route.ts — CRUD routes for /contacts.
 *
 * Result → HTTP status mapping (resultToHttpStatus):
 *   INVALID_PHONE          → 422
 *   CONTACT_ALREADY_EXISTS → 409
 *   CONTACT_NOT_FOUND      → 404
 *   DB_ERROR               → 500
 *
 * HTTP-layer errors (handled outside ContactError):
 *   Zod body invalid        → 400 VALIDATION_ERROR
 *   Missing tenant header   → 401 MISSING_TENANT      (from tenant middleware)
 *   Non-UUID tenant header  → 400 INVALID_TENANT_ID   (from tenant middleware)
 *
 * Wiring: mount tenant middleware on all routes, build repo per-request
 * from c.get('tenantId').
 *
 * GET /contacts returns: { "data": [...] }
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { DbClient } from '../db/client.js';
import { createTenantMiddleware } from '../http/tenant.middleware.js';
import type { ContactError } from './contacts.errors.js';
import { importContacts } from './contacts.import.js';
import { createContactsRepository } from './contacts.repository.js';
import type { ContactRoutingError } from './contacts.routing.errors.js';
import { routeContact } from './contacts.routing.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ContactRouteDeps = {
  readonly db: DbClient;
  readonly env: Env;
};

// ---------------------------------------------------------------------------
// ContactError → HTTP status (exported for unit tests)
// ---------------------------------------------------------------------------

export function resultToHttpStatus(error: ContactError): 422 | 409 | 404 | 500 {
  switch (error.code) {
    case 'INVALID_PHONE':
      return 422;
    case 'CONTACT_ALREADY_EXISTS':
      return 409;
    case 'CONTACT_NOT_FOUND':
      return 404;
    case 'DB_ERROR':
      return 500;
  }
}

// ---------------------------------------------------------------------------
// ContactError → response body (DB_ERROR is surfaced as a generic INTERNAL_ERROR)
// ---------------------------------------------------------------------------

function errorBody(error: ContactError): { error: string } {
  return { error: error.code === 'DB_ERROR' ? 'INTERNAL_ERROR' : error.code };
}

// ---------------------------------------------------------------------------
// ContactRoutingError → HTTP status (routing-specific, exhaustive, separate from CRUD)
// ADR-2: dedicated mapper keeps the switch exhaustive over exactly these 3 codes.
// ---------------------------------------------------------------------------

function routingErrorToHttpStatus(error: ContactRoutingError): 404 | 422 | 500 {
  switch (error.code) {
    case 'CONTACT_NOT_FOUND':
      return 404;
    case 'MISSING_FULL_NAME':
      return 422;
    case 'DB_ERROR':
      return 500;
  }
}

// ---------------------------------------------------------------------------
// Zod body schemas
// ---------------------------------------------------------------------------

const createBodySchema = z.object({
  phone: z.string().min(1),
  fullName: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  intent: z.string().nullable().optional(),
  intentConfidence: z.number().min(0).max(1).nullable().optional(),
});

const patchBodySchema = z.object({
  fullName: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  intent: z.string().nullable().optional(),
  intentConfidence: z.number().min(0).max(1).nullable().optional(),
});

// Reuse the per-row schema from createBodySchema — single source of truth.
// importRowSchema IS createBodySchema; no new fields, no drift between POST / and POST /import.
const importRowSchema = createBodySchema;
const importBodySchema = z.object({
  contacts: z.array(importRowSchema).min(1).max(200),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export const createContactsRoute = (deps: ContactRouteDeps) => {
  const router = new Hono<{ Variables: { tenantId: string } }>();
  const tenantMiddleware = createTenantMiddleware(deps.env);

  // Apply tenant middleware to all routes in this router
  router.use('*', tenantMiddleware);

  // POST /import — bulk import (STATIC path; must be registered BEFORE any /:id dynamic handler)
  router.post('/import', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const parsed = importBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.issues }, 400);
    }

    const tenantId = c.get('tenantId');
    const repo = createContactsRepository(deps.db.withTenant, tenantId);
    const report = await importContacts(repo, parsed.data.contacts);

    const status: 200 | 500 = report.summary.errors > 0 ? 500 : 200;
    return c.json(report, status);
  });

  // POST /:id/route — mark contact as routed + emit ContactLead to outbox (atomic).
  // MUST be registered BEFORE any dynamic /:id handler so Hono's first-match routing
  // resolves to this static /route segment, not the /:id wildcard.
  router.post('/:id/route', async (c) => {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const result = await routeContact(deps.db.withTenant, tenantId, id);
    if (!result.ok) {
      const status = routingErrorToHttpStatus(result.error);
      const body = {
        error: result.error.code === 'DB_ERROR' ? 'INTERNAL_ERROR' : result.error.code,
      };
      return c.json(body, status as 404 | 422 | 500);
    }
    return c.json({ routed: result.value }, 200 as const);
  });

  // POST / — create
  router.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const parsed = createBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.issues }, 400);
    }

    const tenantId = c.get('tenantId');
    const repo = createContactsRepository(deps.db.withTenant, tenantId);
    const result = await repo.create(parsed.data);

    if (!result.ok) {
      const status = resultToHttpStatus(result.error);
      return c.json(errorBody(result.error), status);
    }
    return c.json(result.value, 201);
  });

  // GET / — list
  router.get('/', async (c) => {
    const tenantId = c.get('tenantId');
    const repo = createContactsRepository(deps.db.withTenant, tenantId);
    const result = await repo.list();

    if (!result.ok) {
      const status = resultToHttpStatus(result.error);
      return c.json(errorBody(result.error), status);
    }
    return c.json({ data: result.value }, 200);
  });

  // GET /:id — find by id
  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const repo = createContactsRepository(deps.db.withTenant, tenantId);
    const result = await repo.findById(id);

    if (!result.ok) {
      const status = resultToHttpStatus(result.error);
      return c.json(errorBody(result.error), status);
    }
    return c.json(result.value, 200);
  });

  // PATCH /:id — update
  router.patch('/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const parsed = patchBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.issues }, 400);
    }

    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const repo = createContactsRepository(deps.db.withTenant, tenantId);
    const result = await repo.update(id, parsed.data);

    if (!result.ok) {
      const status = resultToHttpStatus(result.error);
      return c.json(errorBody(result.error), status);
    }
    return c.json(result.value, 200);
  });

  // DELETE /:id — soft delete
  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const repo = createContactsRepository(deps.db.withTenant, tenantId);
    const result = await repo.softDelete(id);

    if (!result.ok) {
      const status = resultToHttpStatus(result.error);
      return c.json(errorBody(result.error), status);
    }
    return new Response(null, { status: 204 });
  });

  return router;
};
