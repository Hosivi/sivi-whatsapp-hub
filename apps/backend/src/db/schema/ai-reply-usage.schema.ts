/**
 * ai-reply-usage.schema.ts — Drizzle schema for the ai_reply_usage table (migration 0009).
 *
 * One row per AI reply that reached at least one successful LLM call. Rows are
 * append-only for the app role (SELECT + INSERT grants); deleted_at is the house
 * soft-delete sentinel. Never stores prompts, customer text or keys.
 *
 * Column notes:
 * - status: 'sent' (outbound_wamid set, written in the same transaction as the
 *   outbound whatsapp_messages row) | 'send_failed' (outbound_wamid NULL — the LLM
 *   ran but the send failed, so the spent tokens are still accounted).
 * - provider / model: the entry that produced the final reply ('unknown' when the
 *   adapter did not report one, e.g. the dev fake).
 * - *_tokens: summed over every LLM call of the reply (normalized LlmUsage);
 *   reasoning_tokens / cached_input_tokens are NULL when no call reported them.
 * - tool_calls: tool names in invocation order; fallback_attempts: failed model
 *   attempts { call, model, reason, status } in order.
 * - latency_ms: wall clock from the start of runAiReply to send completion/failure.
 */

import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AiReplyFallbackAttempt } from '../../ai/llm-usage.js';
import { contactsTable } from './contacts.schema.js';

export const AI_REPLY_USAGE_STATUSES = ['sent', 'send_failed'] as const;

export type AiReplyUsageStatus = (typeof AI_REPLY_USAGE_STATUSES)[number];

export const aiReplyUsageTable = pgTable('ai_reply_usage', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').references(() => contactsTable.id),
  inboundWamid: text('inbound_wamid'),
  outboundWamid: text('outbound_wamid'),
  status: text('status', { enum: AI_REPLY_USAGE_STATUSES }).notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  reasoningTokens: integer('reasoning_tokens'),
  cachedInputTokens: integer('cached_input_tokens'),
  totalTokens: integer('total_tokens').notNull(),
  llmCalls: integer('llm_calls').notNull(),
  toolCalls: text('tool_calls').array().notNull().default(sql`'{}'::text[]`),
  fallbackAttempts: jsonb('fallback_attempts')
    .$type<readonly AiReplyFallbackAttempt[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  latencyMs: integer('latency_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});
