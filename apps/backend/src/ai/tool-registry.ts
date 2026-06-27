/**
 * tool-registry.ts — Governed AI tool registry.
 *
 * Meta-governance invariants (ADR-0008):
 * - The LLM NEVER writes to the DB directly. It emits tool-use blocks.
 * - executeTool validates input (Zod), runs the registered tool, audits via pino.
 * - Unknown tool → error message fed back to LLM (never throws to caller).
 * - Invalid input → Zod rejects BEFORE execute is called (never throws to caller).
 * - Tool context MUST NOT expose a raw DB handle — only scoped repo operations.
 * - All tools return Result<O, ToolError> — never throw in domain logic.
 *
 * Tools registered:
 * - getBusinessInfo: reads pre-loaded TenantAiConfig from ctx (NO second DB query).
 * - classifyContact: writes intent/tags/intentConfidence via contacts repo update (withTenant).
 *
 * ai.invocation_log: OUT OF SCOPE for this slice → pino-only audit.
 */

import type { Logger } from 'pino';
import { z } from 'zod';
import { createContactsRepository } from '../contacts/contacts.repository.js';
import type { ContactPatch } from '../contacts/contacts.repository.js';
import type { TenantRunner } from '../db/client.js';
import type { TenantAiConfig } from '../db/schema/tenant-ai-config.schema.js';
import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type { LlmMessage, LlmTool, ToolUseBlock } from './llm-types.js';

// ---------------------------------------------------------------------------
// ToolContext — what tools receive (NO raw DB handle)
// ---------------------------------------------------------------------------

/**
 * Context passed to each tool's run function.
 * MUST NOT include a raw DB handle (D5) — only pre-loaded config and
 * scoped repo operations are allowed here.
 */
export type ToolContext = {
  /** Pre-loaded TenantAiConfig (null only in defensive test paths). */
  readonly config: TenantAiConfig | null;
  readonly logger: Logger;
  /** Scoped contact update operation — withTenant pre-applied. NO raw DB. */
  readonly updateContact: (id: string, patch: ContactPatch) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// ToolError
// ---------------------------------------------------------------------------

export type ToolError =
  | { readonly code: 'CONFIG_UNAVAILABLE' }
  | { readonly code: 'CONTACT_NOT_FOUND' }
  | { readonly code: 'TOOL_EXEC_ERROR'; readonly cause?: unknown };

// ---------------------------------------------------------------------------
// AiTool<I, O>
// ---------------------------------------------------------------------------

export type AiTool<I, O> = {
  readonly name: string;
  readonly description: string;
  /** Zod schema for runtime input validation BEFORE execute is called. */
  readonly inputSchema: z.ZodType<I>;
  /** JSON Schema handed to the LLM model (decoupled from Zod). */
  readonly schema: Record<string, unknown>;
  run(ctx: ToolContext, tenantId: string, input: I): Promise<Result<O, ToolError>>;
};

// ---------------------------------------------------------------------------
// Tool: getBusinessInfo
// ---------------------------------------------------------------------------

const getBusinessInfoSchema = z.object({}).strict();
type GetBusinessInfoInput = z.infer<typeof getBusinessInfoSchema>;

const getBusinessInfoTool: AiTool<
  GetBusinessInfoInput,
  { business_name: string; business_info: unknown }
> = {
  name: 'getBusinessInfo',
  description:
    'Returns the business name, info, hours, and contact details for the current tenant.',
  inputSchema: getBusinessInfoSchema,
  schema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  async run(ctx, _tenantId, _input) {
    if (!ctx.config) {
      return err({ code: 'CONFIG_UNAVAILABLE' } as const);
    }
    return ok({
      business_name: ctx.config.businessName,
      business_info: ctx.config.businessInfo,
    });
  },
};

// ---------------------------------------------------------------------------
// Tool: classifyContact
// ---------------------------------------------------------------------------

/** Intent values for tienda_general (matches Zod enum in the spec). */
const TIENDA_GENERAL_INTENTS = [
  'ver_catalogo',
  'hacer_pedido',
  'consultar_precio',
  'estado_pedido',
  'otro',
] as const;

const classifyContactSchema = z.object({
  contactId: z.string().uuid(),
  intent: z.enum(TIENDA_GENERAL_INTENTS),
  tags: z.array(z.string()).max(10),
  intentConfidence: z.number().min(0).max(1).optional(),
});
type ClassifyContactInput = z.infer<typeof classifyContactSchema>;

const classifyContactTool: AiTool<ClassifyContactInput, { classified: true }> = {
  name: 'classifyContact',
  description:
    'Classifies the contact intent and tags based on the conversation. ' +
    'Valid intents: ver_catalogo, hacer_pedido, consultar_precio, estado_pedido, otro.',
  inputSchema: classifyContactSchema,
  schema: {
    type: 'object',
    properties: {
      contactId: { type: 'string', format: 'uuid' },
      intent: { type: 'string', enum: [...TIENDA_GENERAL_INTENTS] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      intentConfidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['contactId', 'intent', 'tags'],
    additionalProperties: false,
  },
  async run(ctx, _tenantId, input) {
    const patch: ContactPatch = {
      intent: input.intent,
      tags: input.tags,
      ...(input.intentConfidence !== undefined ? { intentConfidence: input.intentConfidence } : {}),
    };

    const result = await ctx.updateContact(input.contactId, patch);
    // updateContact returns Result<Contact, ContactError> — check the ok flag
    const r = result as { ok: boolean; error?: { code: string } };
    if (!r.ok) {
      const errCode = r.error?.code;
      if (errCode === 'CONTACT_NOT_FOUND') {
        return err({ code: 'CONTACT_NOT_FOUND' } as const);
      }
      return err({ code: 'TOOL_EXEC_ERROR', cause: r.error } as const);
    }
    return ok({ classified: true as const });
  },
};

// ---------------------------------------------------------------------------
// REGISTRY — the allowlist of tools available for tienda_general
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: registry holds mixed input/output types
export const REGISTRY: AiTool<any, any>[] = [getBusinessInfoTool, classifyContactTool];

/** Maps an AiTool to the neutral LlmTool shape handed to the model. */
// biome-ignore lint/suspicious/noExplicitAny: registry holds mixed input/output types
export function toLlmTool(tool: AiTool<any, any>): LlmTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.schema,
  };
}

// ---------------------------------------------------------------------------
// executeTool — the governance gate
// ---------------------------------------------------------------------------

type ExecuteToolDeps = {
  readonly db: { readonly withTenant: TenantRunner };
  readonly logger: Logger;
};

/**
 * Executes a tool invoked by the LLM. Always returns an LlmMessage (role 'tool').
 * Never throws to the caller — all errors become JSON-encoded content messages
 * so the LLM can receive and respond to them in the next turn.
 *
 * Flow:
 * 1. Look up tool in REGISTRY (unknown → { error: 'unknown_tool' }).
 * 2. safeParse input with Zod (invalid → { error: 'invalid_input' } WITHOUT run).
 * 3. Build ToolContext (config pre-loaded; updateContact scoped to tenant).
 * 4. run(ctx, tenantId, parsed.data) → pino audit.
 * 5. Return role:'tool' LlmMessage with JSON content.
 *
 * @param deps     - Narrowed deps: db.withTenant + logger (no full AppDeps needed).
 * @param tenantId - UUID of the calling tenant (for RLS scoping).
 * @param block    - ToolUseBlock emitted by the LLM.
 * @param config   - Pre-loaded TenantAiConfig (null in defensive/test paths only).
 */
export async function executeTool(
  deps: ExecuteToolDeps,
  tenantId: string,
  block: ToolUseBlock,
  config: TenantAiConfig | null,
): Promise<LlmMessage> {
  // Step 1: Look up tool in registry.
  const tool = REGISTRY.find((t) => t.name === block.name);
  if (!tool) {
    deps.logger.warn({ tool: block.name, tenantId }, 'ai_tool_unknown');
    return {
      role: 'tool',
      toolUseId: block.id,
      toolName: block.name,
      content: JSON.stringify({ error: 'unknown_tool' }),
    };
  }

  // Step 2: Zod validate input BEFORE execute.
  const parsed = tool.inputSchema.safeParse(block.input);
  if (!parsed.success) {
    deps.logger.warn(
      { tool: block.name, tenantId, issues: parsed.error.issues },
      'ai_tool_invalid_input',
    );
    return {
      role: 'tool',
      toolUseId: block.id,
      toolName: block.name,
      content: JSON.stringify({ error: 'invalid_input', details: parsed.error.issues }),
    };
  }

  // Step 3: Build ToolContext — NO raw DB handle.
  const contactsRepo = createContactsRepository(deps.db.withTenant, tenantId);
  const ctx: ToolContext = {
    config,
    logger: deps.logger,
    updateContact: (id, patch) => contactsRepo.update(id, patch),
  };

  // Step 4: Execute tool and audit.
  let status: 'ok' | 'error' = 'ok';
  let resultPayload: unknown;

  try {
    const runResult = await tool.run(ctx, tenantId, parsed.data);
    const r = runResult as { ok: boolean; value?: unknown; error?: unknown };
    if (r.ok) {
      resultPayload = r.value;
    } else {
      status = 'error';
      resultPayload = { error: (r.error as { code: string })?.code ?? 'TOOL_EXEC_ERROR' };
    }
  } catch (cause) {
    status = 'error';
    resultPayload = { error: 'TOOL_EXEC_ERROR' };
    deps.logger.error({ tool: block.name, tenantId, cause }, 'ai_tool_exec_threw');
  }

  // Pino audit — one entry per invocation (ai.invocation_log out of scope for this slice).
  deps.logger.info({ tool: block.name, tenantId, status }, 'ai_tool_invocation');

  return {
    role: 'tool',
    toolUseId: block.id,
    toolName: block.name,
    content: JSON.stringify(resultPayload),
  };
}
