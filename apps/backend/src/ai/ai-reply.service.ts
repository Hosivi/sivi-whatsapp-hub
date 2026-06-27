/**
 * ai-reply.service.ts — Governed AI auto-reply service (stub — Lote A).
 *
 * This file is intentionally minimal for Lote A (PR2 data layer).
 * It will be extended in Lote B with the full runAiReply orchestrator.
 *
 * RLS invariants:
 * - All queries run inside withTenant (no WHERE tenant_id).
 * - No adminSql handle anywhere in this file.
 * - Returns plain values (boolean), never throws — errors bubble as rejected
 *   promises from the TenantRunner and are caught at the call site.
 */

import { sql } from 'drizzle-orm';
import type { TenantRunner } from '../db/client.js';

// ---------------------------------------------------------------------------
// isWithin24hServiceWindow
// ---------------------------------------------------------------------------

/**
 * Returns true when the contact sent an inbound message within the last 24 hours.
 *
 * Implements the WhatsApp 24h service window rule (spec §3):
 * - Compares MAX(received_at) WHERE direction='inbound' to NOW() - INTERVAL '24 hours'.
 * - Uses DB server time (NOW()) for correctness — avoids Node.js clock skew.
 * - Returns false if no inbound messages exist for the contact.
 *
 * @param withTenant - TenantRunner (RLS-scoped)
 * @param tenantId   - UUID of the tenant
 * @param contactId  - UUID of the contact to check
 */
export async function isWithin24hServiceWindow(
  withTenant: TenantRunner,
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    // Single query: compare MAX(received_at) to DB server time in SQL.
    // Using DB NOW() avoids Node.js clock skew. COALESCE handles the no-rows case.
    const rows = await tx.execute(
      sql`
        SELECT COALESCE(
          MAX(received_at) > NOW() - INTERVAL '24 hours',
          false
        ) AS within_window
        FROM whatsapp_messages
        WHERE contact_id = ${contactId}::uuid
          AND direction = 'inbound'
      `,
    );

    const row = (rows as unknown as Array<{ within_window: boolean }>)[0];
    return row?.within_window === true;
  });
}
