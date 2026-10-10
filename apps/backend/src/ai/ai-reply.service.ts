/**
 * ai-reply.service.ts — Governed AI auto-reply orchestrator.
 *
 * Exports:
 * - isWithin24hServiceWindow: WhatsApp 24h service window check (data query).
 * - runAiReply: full orchestrator — config load → window check → LLM loop → send.
 *
 * Design invariants:
 * - D2: runAiReply is ONE pure-ish orchestrator returning Result; infra throws caught at boundary.
 * - D3: caller fires void runAiReply().catch() — never awaited in the route handler.
 * - D4: Tool registry = allowlist; LLM only invokes registered, Zod-validated tools.
 * - D5: LLM gets NO DB handle. Tools run via withTenant scoped repos.
 * - D8: Customer text NEVER in system prompt; system is a separate param to llm.complete().
 *
 * RLS invariants:
 * - All queries run inside withTenant (no WHERE tenant_id).
 * - No adminSql handle anywhere in this file.
 *
 * Bounded loop: max 5 LLM iterations (ai-agents.md §8). If exhausted without text
 * response: pino warn ('ai_tool_limit_reached'), return err(LLM_FAILED), NO reply sent.
 */

import { sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import type { TenantRunner } from '../db/client.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import { getConversationHistory } from '../whatsapp-messages/whatsapp-messages.repository.js';
import { sendWhatsappText } from '../whatsapp-send/whatsapp-send.service.js';
import { insertAiReplyUsageTx, persistAiReplyUsage } from './ai-reply-usage.repository.js';
import type { AiReplyUsageRecord } from './ai-reply-usage.repository.js';
import type { LlmMessage } from './llm-types.js';
import { EMPTY_USAGE_TALLY, tallyLlmCall } from './llm-usage.js';
import type { AiReplyUsageTally } from './llm-usage.js';
import { buildTiendaGeneralSystemPrompt } from './system-prompt.js';
import { getTenantAiConfig } from './tenant-ai-config.repository.js';
import { REGISTRY, executeTool, toLlmTool } from './tool-registry.js';

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

// ---------------------------------------------------------------------------
// runAiReply — public API types
// ---------------------------------------------------------------------------

export type AiReplyInput = {
  readonly tenantId: string;
  readonly contactId: string;
  readonly fromPhoneE164: string;
  readonly text: string;
  /** wamid of the inbound message being answered; stored on the usage row when known. */
  readonly inboundWamid?: string;
};

export type AiReplyError =
  | { readonly code: 'AI_DISABLED' }
  | { readonly code: 'WINDOW_CLOSED' }
  | { readonly code: 'NO_API_KEY' }
  | { readonly code: 'LLM_FAILED'; readonly cause?: unknown }
  | { readonly code: 'SEND_FAILED'; readonly cause?: unknown }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };

export type AiReplyOk = {
  readonly wamid: string;
  readonly toolCalls: string[];
};

// ---------------------------------------------------------------------------
// Usage accounting helpers (counts and labels only — never prompts or customer text)
// ---------------------------------------------------------------------------

/** provider/model label when no LLM response reported its answering model. */
const UNKNOWN_MODEL_LABEL = 'unknown';

const elapsedMs = (startedAt: number): number =>
  Math.max(0, Math.round(performance.now() - startedAt));

/** Safe-to-log usage fields for ai_reply_sent / ai_reply_failed / ai_tool_limit_reached. */
const usageLogFields = (tally: AiReplyUsageTally) =>
  tally.llmCalls === 0
    ? {}
    : {
        provider: tally.answeredBy?.provider ?? UNKNOWN_MODEL_LABEL,
        model: tally.answeredBy?.model ?? UNKNOWN_MODEL_LABEL,
        modelsUsed: tally.modelsUsed,
        inputTokens: tally.inputTokens,
        outputTokens: tally.outputTokens,
        reasoningTokens: tally.reasoningTokens,
        cachedInputTokens: tally.cachedInputTokens,
        totalTokens: tally.totalTokens,
        llmCalls: tally.llmCalls,
        fallbackCount: tally.fallbackAttempts.length,
      };

function toUsageRecord(
  input: AiReplyInput,
  tally: AiReplyUsageTally,
  toolCalls: readonly string[],
  outcome: Pick<AiReplyUsageRecord, 'status' | 'outboundWamid' | 'latencyMs'>,
): AiReplyUsageRecord {
  return {
    contactId: input.contactId,
    inboundWamid: input.inboundWamid ?? null,
    outboundWamid: outcome.outboundWamid,
    status: outcome.status,
    provider: tally.answeredBy?.provider ?? UNKNOWN_MODEL_LABEL,
    model: tally.answeredBy?.model ?? UNKNOWN_MODEL_LABEL,
    inputTokens: tally.inputTokens,
    outputTokens: tally.outputTokens,
    reasoningTokens: tally.reasoningTokens,
    cachedInputTokens: tally.cachedInputTokens,
    totalTokens: tally.totalTokens,
    llmCalls: tally.llmCalls,
    toolCalls: [...toolCalls],
    fallbackAttempts: tally.fallbackAttempts,
    latencyMs: outcome.latencyMs,
  };
}

/**
 * The send failed after the LLM ran: keep the spent tokens in a 'send_failed' row
 * (own transaction, no outbound wamid). Fail-soft — a failure is logged, never thrown.
 */
async function persistSendFailedUsage(
  deps: AppDeps,
  tenantId: string,
  record: AiReplyUsageRecord,
): Promise<void> {
  try {
    const outcome = await persistAiReplyUsage(deps.db.withTenant, tenantId, record);
    if (outcome === 'table_missing') {
      deps.logger.error({ tenantId }, 'ai_reply_usage_not_persisted reason=TABLE_MISSING');
    }
  } catch (cause) {
    deps.logger.error({ tenantId, cause }, 'ai_reply_usage_not_persisted reason=DB_ERROR');
  }
}

// ---------------------------------------------------------------------------
// runAiReply — orchestrator
// ---------------------------------------------------------------------------

/**
 * Governed AI auto-reply orchestrator.
 *
 * Steps (design.md §D2):
 * 1. getTenantAiConfig → none/err → AI_DISABLED / DB_ERROR.
 * 2. config.enabled check → AI_DISABLED.
 * 3. 24h service window check → WINDOW_CLOSED.
 * 4. getConversationHistory(10) → LlmMessage[].
 * 5. Build system prompt (buildTiendaGeneralSystemPrompt).
 * 6. Build LLM tool list (REGISTRY.map(toLlmTool)).
 * 7. Bounded loop (max 5):
 *    - llm.complete → if no toolUses, send text and return ok.
 *    - else: push assistant-tool-use + execute each tool + push tool results, loop.
 *    - Exhausted → warn log, err(LLM_FAILED), NO reply.
 * 8. sendWhatsappText → wamid → ok.
 *
 * Usage accounting: token usage, answering model and fallback attempts of every
 * successful LLM call are tallied. On a successful send ONE 'sent' ai_reply_usage
 * row is written in the SAME transaction as the outbound message row; when the LLM
 * ran but the send failed, a 'send_failed' row keeps the spent tokens. No row when
 * no LLM call completed. A missing table (0009 not applied) is logged, never fatal.
 *
 * All errors returned as Result — NEVER thrown to caller.
 * Pino audits at each gate: ai_reply_skipped, ai_tool_limit_reached, ai_reply_sent,
 * ai_reply_failed (with provider, model and token totals once an LLM call completed),
 * ai_reply_usage_not_persisted.
 *
 * @param deps  - Full AppDeps (db, llm, meta, logger, env).
 * @param input - { tenantId, contactId, fromPhoneE164, text }.
 */
export async function runAiReply(
  deps: AppDeps,
  input: AiReplyInput,
): Promise<Result<AiReplyOk, AiReplyError>> {
  const { tenantId, contactId, fromPhoneE164 } = input;
  // Wall-clock latency of the reply: from here to send completion (or failure).
  const startedAt = performance.now();

  try {
    // Step 1: Load tenant AI config (pre-load; getBusinessInfo tool reads from ctx, no 2nd query).
    const configResult = await getTenantAiConfig(deps.db.withTenant, tenantId);
    if (!configResult.ok) {
      deps.logger.error({ tenantId, error: configResult.error }, 'ai_reply_failed DB_ERROR');
      return err({ code: 'DB_ERROR', cause: configResult.error } as const);
    }
    const config = configResult.value;

    // Step 2: Check if AI is enabled for this tenant.
    if (config === null || !config.enabled) {
      deps.logger.info({ tenantId }, 'ai_reply_skipped reason=AI_DISABLED');
      return err({ code: 'AI_DISABLED' } as const);
    }

    // Step 3: Check 24h service window.
    const withinWindow = await isWithin24hServiceWindow(deps.db.withTenant, tenantId, contactId);
    if (!withinWindow) {
      deps.logger.info({ tenantId, contactId }, 'ai_reply_skipped reason=WINDOW_CLOSED');
      return err({ code: 'WINDOW_CLOSED' } as const);
    }

    // Step 4: Load conversation history (inbound messages → role 'user').
    const history = await getConversationHistory(deps.db.withTenant, tenantId, contactId, 10);

    // Step 5: Build system prompt from pre-loaded config (D8 — no customer text).
    const system = buildTiendaGeneralSystemPrompt(config);

    // Step 6: Build LLM tool list from the allowlist registry.
    const llmTools = REGISTRY.map(toLlmTool);

    // Step 7: Bounded LLM loop (max 5 iterations).
    let messages: LlmMessage[] = history;
    const allToolCalls: string[] = [];
    const MAX_ITERATIONS = 5;
    // Usage of every successful LLM call of this reply (tokens, models, fallbacks).
    let tally: AiReplyUsageTally = EMPTY_USAGE_TALLY;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // Call LLM.
      let llmResult: Awaited<ReturnType<typeof deps.llm.complete>>;
      try {
        llmResult = await deps.llm.complete(system, messages, llmTools);
      } catch (cause) {
        deps.logger.error(
          { tenantId, cause, ...usageLogFields(tally) },
          'ai_reply_failed LLM threw unexpectedly',
        );
        return err({ code: 'LLM_FAILED', cause } as const);
      }

      if (!llmResult.ok) {
        deps.logger.error(
          { tenantId, error: llmResult.error, ...usageLogFields(tally) },
          'ai_reply_failed reason=LLM_FAILED',
        );
        return err({ code: 'LLM_FAILED', cause: llmResult.error } as const);
      }

      tally = tallyLlmCall(tally, llmResult.value);
      const { text, toolUses } = llmResult.value;

      // No tool uses → text response.
      if (toolUses.length === 0) {
        const replyText = text ?? '';
        const replyTally = tally;
        const sendResult = await sendWhatsappText(
          deps,
          tenantId,
          { to: fromPhoneE164, text: replyText },
          {
            // Same transaction as the outbound message row: both commit or neither.
            persistInTx: async (tx, { wamid }) => {
              const record = toUsageRecord(input, replyTally, allToolCalls, {
                status: 'sent',
                outboundWamid: wamid,
                latencyMs: elapsedMs(startedAt),
              });
              const outcome = await insertAiReplyUsageTx(tx, tenantId, record);
              if (outcome === 'table_missing') {
                // Migration 0009 not applied yet: keep the message row, report the gap.
                deps.logger.error(
                  { tenantId, wamid },
                  'ai_reply_usage_not_persisted reason=TABLE_MISSING',
                );
              }
            },
          },
        );

        if (!sendResult.ok) {
          deps.logger.error(
            { tenantId, error: sendResult.error, ...usageLogFields(tally) },
            'ai_reply_failed reason=SEND_FAILED',
          );
          // DB_ERROR = the reply WAS delivered but its persist tx rolled back, so it
          // is not a failed send; every other code means nothing reached the customer.
          if (sendResult.error.code !== 'DB_ERROR') {
            await persistSendFailedUsage(
              deps,
              tenantId,
              toUsageRecord(input, tally, allToolCalls, {
                status: 'send_failed',
                outboundWamid: null,
                latencyMs: elapsedMs(startedAt),
              }),
            );
          }
          return err({ code: 'SEND_FAILED', cause: sendResult.error } as const);
        }

        deps.logger.info(
          {
            tenantId,
            wamid: sendResult.value.wamid,
            toolCalls: allToolCalls,
            iteration,
            ...usageLogFields(tally),
            latencyMs: elapsedMs(startedAt),
          },
          'ai_reply_sent',
        );
        return ok({ wamid: sendResult.value.wamid, toolCalls: allToolCalls });
      }

      // Tool uses — push assistant tool-use turn + execute each tool.
      messages = [...messages, { role: 'assistant-tool-use' as const, toolUses }];

      for (const block of toolUses) {
        allToolCalls.push(block.name);
        const toolMsg = await executeTool(
          { db: deps.db, logger: deps.logger },
          tenantId,
          block,
          config,
        );
        messages = [...messages, toolMsg];
      }
    }

    // Max iterations exhausted — no text response received.
    deps.logger.warn(
      {
        tenantId,
        contactId,
        iterations: MAX_ITERATIONS,
        toolCalls: allToolCalls,
        ...usageLogFields(tally),
      },
      'ai_tool_limit_reached',
    );
    return err({ code: 'LLM_FAILED' } as const);
  } catch (cause) {
    // Last-resort catch for unexpected exceptions (infrastructure failures, etc.).
    deps.logger.error({ tenantId, cause }, 'ai_reply_failed unexpected exception');
    return err({ code: 'DB_ERROR', cause } as const);
  }
}
