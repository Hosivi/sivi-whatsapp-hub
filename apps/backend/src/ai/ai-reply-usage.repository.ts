/**
 * ai-reply-usage.repository.ts — Writes ai_reply_usage rows and reads them back by
 * outbound wamid.
 *
 * RLS invariants (mirrors whatsapp-messages.repository.ts):
 * - Every query runs on a tx opened by withTenant (app.current_tenant set) — the
 *   tenant_isolation policy scopes reads and rejects cross-tenant writes.
 * - NO WHERE tenant_id anywhere; tenant_id is only WRITTEN on insert (checked by
 *   the policy's WITH CHECK).
 * - NO adminSql handle.
 *
 * Rollout guard: the app can start before migration 0009 reaches a database. Each
 * entry point first probes to_regclass('public.ai_reply_usage') in the same tx; a
 * missing table yields 'table_missing' / an empty lookup instead of an error, so a
 * reply is still persisted and GET /whatsapp-messages keeps working.
 *
 * Infrastructure: DB failures throw (callers decide how to surface them).
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantRunner } from '../db/client.js';
import { aiReplyUsageTable } from '../db/schema/ai-reply-usage.schema.js';
import type { AiReplyUsageStatus } from '../db/schema/ai-reply-usage.schema.js';
import type { AiReplyFallbackAttempt } from './llm-usage.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One AI reply's usage, as persisted (tenant_id comes from the call, never the record). */
export type AiReplyUsageRecord = {
  readonly contactId: string | null;
  readonly inboundWamid: string | null;
  /** Set for 'sent'; null for 'send_failed' (enforced by a CHECK constraint). */
  readonly outboundWamid: string | null;
  readonly status: AiReplyUsageStatus;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly totalTokens: number;
  readonly llmCalls: number;
  readonly toolCalls: readonly string[];
  readonly fallbackAttempts: readonly AiReplyFallbackAttempt[];
  readonly latencyMs: number;
};

/** 'table_missing' = migration 0009 not applied yet; nothing was written. */
export type AiReplyUsageWriteOutcome = 'inserted' | 'table_missing';

/** Usage of an AI-authored outbound message, as exposed by GET /whatsapp-messages. */
export type AiReplyUsageSummary = {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number;
  readonly latencyMs: number;
  readonly llmCalls: number;
  readonly toolCalls: readonly string[];
  readonly fallbackCount: number;
};

// ---------------------------------------------------------------------------
// Rollout guard
// ---------------------------------------------------------------------------

/** True when ai_reply_usage exists (migration 0009 applied). Privilege-independent. */
export async function aiReplyUsageTableExists(tx: PostgresJsDatabase): Promise<boolean> {
  const rows = await tx.execute(
    sql`SELECT to_regclass('public.ai_reply_usage') IS NOT NULL AS present`,
  );
  return (rows as unknown as Array<{ present?: unknown }>)[0]?.present === true;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Inserts one usage row on an EXISTING tenant-scoped tx — used inside the outbound
 * send transaction so the usage row and the message row commit or roll back together.
 * Throws on any DB error (the caller's tx then rolls back).
 */
export async function insertAiReplyUsageTx(
  tx: PostgresJsDatabase,
  tenantId: string,
  record: AiReplyUsageRecord,
): Promise<AiReplyUsageWriteOutcome> {
  if (!(await aiReplyUsageTableExists(tx))) return 'table_missing';
  await tx.insert(aiReplyUsageTable).values({
    tenantId,
    contactId: record.contactId,
    inboundWamid: record.inboundWamid,
    outboundWamid: record.outboundWamid,
    status: record.status,
    provider: record.provider,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    reasoningTokens: record.reasoningTokens,
    cachedInputTokens: record.cachedInputTokens,
    totalTokens: record.totalTokens,
    llmCalls: record.llmCalls,
    toolCalls: [...record.toolCalls],
    fallbackAttempts: record.fallbackAttempts,
    latencyMs: record.latencyMs,
  });
  return 'inserted';
}

/** Inserts one usage row in its own tenant-scoped transaction (the send_failed path). */
export function persistAiReplyUsage(
  withTenant: TenantRunner,
  tenantId: string,
  record: AiReplyUsageRecord,
): Promise<AiReplyUsageWriteOutcome> {
  return withTenant(tenantId, (tx) => insertAiReplyUsageTx(tx, tenantId, record));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Live (deleted_at IS NULL) 'sent' usage rows for the given outbound wamids, keyed
 * by wamid (oldest row wins if a wamid ever had two). RLS-scoped through `tx`.
 * Empty when there is nothing to look up or the table is not migrated yet.
 */
export async function findSentUsageByOutboundWamids(
  tx: PostgresJsDatabase,
  outboundWamids: readonly string[],
): Promise<ReadonlyMap<string, AiReplyUsageSummary>> {
  const byWamid = new Map<string, AiReplyUsageSummary>();
  if (outboundWamids.length === 0 || !(await aiReplyUsageTableExists(tx))) return byWamid;

  const rows = await tx
    .select({
      outboundWamid: aiReplyUsageTable.outboundWamid,
      provider: aiReplyUsageTable.provider,
      model: aiReplyUsageTable.model,
      inputTokens: aiReplyUsageTable.inputTokens,
      outputTokens: aiReplyUsageTable.outputTokens,
      reasoningTokens: aiReplyUsageTable.reasoningTokens,
      totalTokens: aiReplyUsageTable.totalTokens,
      latencyMs: aiReplyUsageTable.latencyMs,
      llmCalls: aiReplyUsageTable.llmCalls,
      toolCalls: aiReplyUsageTable.toolCalls,
      fallbackAttempts: aiReplyUsageTable.fallbackAttempts,
    })
    .from(aiReplyUsageTable)
    .where(
      and(
        inArray(aiReplyUsageTable.outboundWamid, [...outboundWamids]),
        eq(aiReplyUsageTable.status, 'sent'),
        isNull(aiReplyUsageTable.deletedAt),
      ),
    )
    .orderBy(asc(aiReplyUsageTable.createdAt));

  for (const row of rows) {
    if (row.outboundWamid === null || byWamid.has(row.outboundWamid)) continue;
    byWamid.set(row.outboundWamid, {
      provider: row.provider,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens ?? null,
      totalTokens: row.totalTokens,
      latencyMs: row.latencyMs,
      llmCalls: row.llmCalls,
      toolCalls: row.toolCalls,
      fallbackCount: Array.isArray(row.fallbackAttempts) ? row.fallbackAttempts.length : 0,
    });
  }
  return byWamid;
}
