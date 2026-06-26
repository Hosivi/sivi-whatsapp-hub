/**
 * tenant-ai-config.schema.ts — Drizzle schema for the tenant_ai_config table.
 *
 * Stores per-tenant AI configuration: the vertical the tenant operates in,
 * business info used by AI tools, and an optional system prompt override.
 *
 * Column notes:
 * - vertical: the business vertical (e.g. 'tienda_general'). Only one active
 *   row per (tenant_id, vertical) is allowed (partial unique index on deleted_at IS NULL).
 * - business_info: JSONB blob consumed by the getBusinessInfo AI tool.
 * - enabled: soft-toggle; false = AI reply is silently skipped.
 * - system_prompt_override: when non-null, replaces the generated system prompt entirely.
 * - deleted_at: soft-delete sentinel; NULL = active.
 */

import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const tenantAiConfigTable = pgTable('tenant_ai_config', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  vertical: text('vertical').notNull(),
  businessName: text('business_name').notNull(),
  businessInfo: jsonb('business_info').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  systemPromptOverride: text('system_prompt_override'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

export type TenantAiConfig = {
  readonly id: string;
  readonly tenantId: string;
  readonly vertical: string;
  readonly businessName: string;
  readonly businessInfo: unknown;
  readonly enabled: boolean;
  readonly systemPromptOverride: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
};

export const mapRowToTenantAiConfig = (
  row: typeof tenantAiConfigTable.$inferSelect,
): TenantAiConfig => ({
  id: row.id,
  tenantId: row.tenantId,
  vertical: row.vertical,
  businessName: row.businessName,
  businessInfo: row.businessInfo,
  enabled: row.enabled,
  systemPromptOverride: row.systemPromptOverride ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt ?? null,
});
