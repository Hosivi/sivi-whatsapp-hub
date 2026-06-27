# Design: ai-reply — Governed AI auto-reply + auto-classify

Architecture for the first governed AI loop on `tienda_general`: a customer's inbound WhatsApp
message triggers a fire-and-forget pipeline that loads the tenant's AI config, enforces the 24h
service window, builds a scoped system prompt, calls an injectable `LlmAdapter`, executes only
registered/audited Tools, and replies via the existing `sendWhatsappText`. The LLM never touches
the DB. Everything is `Result<T,E>`; nothing throws to the webhook handler.

This design is a strict subset of `Docs/specs/ai-agents.md` (the authoritative source). Where this
doc and the spec differ in scope, the spec is the long-term target and THIS slice implements only
what the proposal declares in-scope.

## Quick path (the runtime flow)

1. Inbound POST `/webhooks/whatsapp` persists the message and returns `200` (unchanged ack-fast).
2. AFTER the `200` is returned, the route fires `runAiReply(deps, input)` WITHOUT `await`,
   wrapped in `.catch(err => logger.error(...))`.
3. `runAiReply` runs the governed loop and either sends one reply + classifies the contact, or
   skips silently (disabled / window closed / no API key) — always logged, never thrown.

## Decision summary (ADR-style)

| # | Decision | Rationale | Rejected alternative |
|---|----------|-----------|----------------------|
| D1 | `LlmAdapter` injectable interface, mirrors `MetaClient` | Same functional-DI seam already proven for Meta egress; swap real/fake by composition root only (ADR-0008) | A class-based adapter or a DI container — banned by house rules |
| D2 | `runAiReply` is one pure-ish orchestrator returning `Result`, infra throws caught at its own boundary | Keeps the webhook handler dumb; the whole loop is one testable unit; matches `sendWhatsappText` shape | Spreading the loop across the route handler — couples ack-fast to AI failure modes |
| D3 | Fire-and-forget AFTER `c.json/c.text` 200, no `await`, top-level `.catch` | Preserves the ack-fast contract (Meta must get 200 fast); zero infra; an unhandled rejection cannot crash Node 22 | `await` in the route (breaks ack-fast); pg-boss queue (infra cost deferred to slice #2) |
| D4 | Tool registry = typed `AiTool<I,O>` objects; the registry IS the allowlist | Governed AI: LLM can only invoke registered, Zod-validated, pino-audited tools (ADR-0008, Meta 2026) | Letting the LLM call arbitrary functions — WABA suspension risk |
| D5 | LLM gets NO DB handle; tools receive `deps` + `tenantId` and run `withTenant` | The LLM proposes tool calls; the APP executes them under RLS | Passing `db`/`tx` into the adapter — violates the isolation invariant |
| D6 | New `tenant_ai_config` table, RLS `tenant_isolation`, grant `app_rls` | Per-tenant config (vertical, business_info, enabled, prompt override) with the same RLS pattern as every domain table | Reusing `whatsapp_accounts` (wrong domain) or env-only config (not multi-tenant) |
| D7 | Fake LLM gated on `ENABLE_DEV_ENDPOINTS` (mirror Meta fake-client gate) | Dev console works without a real Anthropic key; same explicit-`'true'` gate as `meta` in `main.ts` | Requiring a real key in dev (friction) or always-fake (no prod path) |
| D8 | Customer text only ever in the `user` role; system prompt is immutable per vertical | Prompt-injection mitigation; the customer can never rewrite the agent's instructions | Concatenating customer text into the system prompt |

## Module layout

All new code lives under `apps/backend/src/ai/`.

```
apps/backend/src/ai/
  llm-adapter.ts            # LlmAdapter interface + createAnthropicAdapter + createFakeLlmAdapter
  llm-types.ts              # LlmMessage, LlmTool, LlmResponse, ToolUseBlock, LlmError (shared types)
  tool-registry.ts          # AiTool<I,O> type, getBusinessInfo, classifyContact, buildToolRegistry, executeTool
  system-prompt.ts          # buildTiendaGeneralSystemPrompt(config) — spec §5 base, scoped
  ai-reply.service.ts       # runAiReply(deps, input) orchestrator + AiReplyError
  tenant-ai-config.repository.ts  # getTenantAiConfig(withTenant, tenantId) → Result
apps/backend/src/db/schema/
  tenant-ai-config.schema.ts  # Drizzle table + TenantAiConfig domain type + mapRow
apps/backend/drizzle/
  0004_tenant_ai_config.sql   # table + RLS + grant (hand-written RLS block)
```

Modified files:

| File | Change |
|------|--------|
| `apps/backend/src/app.ts` | `AppDeps.llm: LlmAdapter` |
| `apps/backend/src/main.ts` | instantiate Anthropic vs fake adapter (gated like `meta`) |
| `apps/backend/src/config/env.ts` | `ANTHROPIC_API_KEY` (optional), `AI_MODEL` (default) |
| `apps/backend/src/webhooks/whatsapp.route.ts` | fire-and-forget `runAiReply(...)` after 200 |
| `apps/backend/src/whatsapp-messages/whatsapp-messages.repository.ts` | `getConversationHistory(withTenant, tenantId, contactId, limit)` |
| `apps/backend/src/db/migrate.ts` | append `0004_tenant_ai_config.sql` to `MIGRATION_FILES` |
| `apps/backend/test/_helpers/test-db.ts` | append `0004` to `MIGRATION_FILES` + truncate list |
| `apps/backend/src/db/seed-dev.ts` | insert one enabled `tienda_general` config for `DEV_TENANT_ID` |
| `apps/backend/package.json` | add `@anthropic-ai/sdk` |

## D1 — LlmAdapter interface (mirrors MetaClient)

`apps/backend/src/ai/llm-types.ts` — provider-neutral shapes (no Anthropic types leak into the orchestrator):

```ts
/** A single conversation message. Customer text is ALWAYS role 'user' (injection mitigation). */
export type LlmMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string }
  // tool result fed back to the model after the app executes a tool_use block
  | { readonly role: 'tool'; readonly toolUseId: string; readonly content: string };

/** A tool the model MAY invoke. name + JSON-schema params (Zod → JSON schema at registration). */
export type LlmTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>; // JSON Schema object
};

/** One tool_use block the model emitted. The app maps name → registry → execution. */
export type ToolUseBlock = {
  readonly id: string;       // toolUseId — echoed back in the 'tool' result message
  readonly name: string;
  readonly input: unknown;   // RAW model output — Zod-validated by the registry before use
};

/** Adapter response. Either plain text to send, and/or tool_use blocks to execute. */
export type LlmResponse = {
  readonly text: string | null;            // assistant prose (may be null on a pure tool turn)
  readonly toolUses: readonly ToolUseBlock[]; // empty array = no tools requested this turn
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
};

export type LlmError =
  | { readonly code: 'LLM_API_ERROR'; readonly status?: number; readonly detail?: string }
  | { readonly code: 'LLM_NETWORK_ERROR'; readonly cause?: unknown }
  | { readonly code: 'LLM_BAD_RESPONSE'; readonly detail?: string };
```

`apps/backend/src/ai/llm-adapter.ts`:

```ts
export type LlmAdapter = {
  /**
   * Single method (ai-agents.md §8). The system prompt is the FIRST element of `messages`
   * with role 'user' is NEVER the system prompt — system is passed separately to keep the
   * customer turn isolated. Implementation maps to the provider's wire format.
   */
  complete(
    system: string,
    messages: readonly LlmMessage[],
    tools: readonly LlmTool[],
  ): Promise<Result<LlmResponse, LlmError>>;
};

// Real — @anthropic-ai/sdk. Never logs the apiKey. Maps Anthropic content blocks → LlmResponse.
export const createAnthropicAdapter = (apiKey: string, model: string): LlmAdapter => ({ /* ... */ });

// Fake — deterministic, programmable, records calls (mirrors createFakeMetaClient).
export const createFakeLlmAdapter = (
  script?: Array<Result<LlmResponse, LlmError>>,
): LlmAdapter & {
  calls: Array<{ system: string; messages: readonly LlmMessage[]; tools: readonly LlmTool[] }>;
  queueResponse(r: Result<LlmResponse, LlmError>): void;
} => { /* dequeues script per call; default = ok({ text: 'fake reply', toolUses: [], stopReason: 'end_turn' }) */ };
```

Why `system` is a separate parameter (not a message): keeps the immutable per-vertical prompt out
of the conversation array, so customer text in the `user` role can never be confused with or
overwrite system instructions (D8). The Anthropic SDK natively takes `system` separately, so this
mirrors the wire format without leakage.

## D2/D3 — runAiReply orchestrator

`apps/backend/src/ai/ai-reply.service.ts`. Input is what the webhook already has after persisting:

```ts
export type AiReplyInput = {
  readonly tenantId: string;
  readonly contactId: string;
  readonly fromPhoneE164: string; // the customer's number = reply destination
  readonly text: string;          // the inbound text body (already persisted)
};

export type AiReplyError =
  | { readonly code: 'AI_DISABLED' }            // config.enabled = false OR no row
  | { readonly code: 'WINDOW_CLOSED' }          // last inbound > 24h
  | { readonly code: 'NO_API_KEY' }             // adapter is fake/absent in a prod-like path
  | { readonly code: 'LLM_FAILED'; readonly cause: LlmError }
  | { readonly code: 'SEND_FAILED'; readonly cause: WhatsappSendError }
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown };
```

Flow (every step a typed `Result`; the whole function never throws — infra throws are caught and
mapped to `DB_ERROR`):

```
runAiReply(deps, input):
  1. config = getTenantAiConfig(deps.db.withTenant, input.tenantId)   // RLS read
        err  → return err(DB_ERROR)
        none → return err(AI_DISABLED)
  2. if !config.enabled                → return err(AI_DISABLED)
  3. window = isWithin24hServiceWindow(deps.db.withTenant, tenantId, contactId)
        // MAX(received_at) WHERE direction='inbound' for this contact, RLS-scoped
        closed → return err(WINDOW_CLOSED)
  4. history = getConversationHistory(withTenant, tenantId, contactId, limit=10)
        // chronological, mapped to LlmMessage[] (inbound→'user', outbound→'assistant')
  5. system = buildTiendaGeneralSystemPrompt(config)   // spec §5, scoped to tienda_general
  6. tools = buildToolRegistry(deps).map(toLlmTool)    // name/desc/JSON-schema only
  7. messages = [...history]   // last item is the just-received customer 'user' turn
  8. LOOP (max 5 iterations — ai-agents.md §8):
       resp = deps.llm.complete(system, messages, tools)
         err → return err(LLM_FAILED, cause)
       if resp.toolUses is empty:                 // model produced final prose
         break with replyText = resp.text
       for each toolUse in resp.toolUses:
         result = executeTool(deps, tenantId, toolUse)   // Zod-validate input → run → pino audit
         push assistant turn (the tool_use) + 'tool' result turn into messages
       // loop continues so the model can use tool outputs to compose the reply
     if loop exhausted without final prose:
       replyText = OUT_OF_SCOPE_FALLBACK  // spec §4 menu (deterministic, no escalateToHuman side effect this slice)
  9. send = sendWhatsappText(deps, tenantId, { to: input.fromPhoneE164, text: replyText })
        err → return err(SEND_FAILED, cause)
 10. return ok({ wamid: send.value.wamid, toolCalls: <names executed> })
```

Notes:

- `sendWhatsappText` is reused verbatim — it resolves the active account, calls Meta outside any
  tx, then persists the outbound row. The orchestrator does NOT write `whatsapp_messages` itself.
- The 24h window is the SERVICE window: customer wrote first inside 24h = consent (proposal D).
  Source of truth = `MAX(received_at)` of inbound rows for this contact. Implemented as a small
  read helper alongside `getConversationHistory` (both are RLS-scoped reads on `whatsapp_messages`).
- Max 5 tool-call iterations matches ai-agents.md §8. This slice does NOT auto-invoke
  `escalateToHuman` on exhaustion (that Tool/side-effect is out of scope per proposal); it falls
  back to the §4 out-of-scope menu text instead.

## D3 — Webhook trigger (exact placement)

In `apps/backend/src/webhooks/whatsapp.route.ts`, the POST handler currently returns `c.text('ok', 200)`
on both success and error. The fire-and-forget call goes on the SUCCESS path, AFTER the result is
known and BEFORE/at the point of returning 200. Because Hono returns the `Response` synchronously
from the handler's return value, we trigger the async work without awaiting it, then return:

```ts
// inside router.post('/', async (c) => { ... })
const result = await handleInboundMessage(deps, rawBody, signatureHeader);

if (!result.ok) {
  // ...existing ack-fast logging, then:
  return c.text('ok', 200);
}

// SUCCESS — message persisted. Fire the AI reply WITHOUT awaiting.
// A rejected promise here MUST NOT crash Node 22 → top-level .catch → pino.
// We need the persisted message's fields; handleInboundMessage returns { wamid, contactId }.
// tenantId / fromPhoneE164 / text are resolved in the service; expose them on the success value.
void runAiReply(deps, {
  tenantId: result.value.tenantId,
  contactId: result.value.contactId,
  fromPhoneE164: result.value.fromPhoneE164,
  text: result.value.text,
}).catch((cause) => {
  deps.logger.error({ cause, contactId: result.value.contactId }, '[ai-reply] unhandled rejection');
});

return c.text('ok', 200);
```

Required supporting change: `handleInboundMessage` currently returns `{ wamid, contactId }`. Extend
its success value to also carry `tenantId`, `fromPhoneE164`, and `text` so the route can build
`AiReplyInput` without re-parsing. This is additive (no contract change at the HTTP layer; the route
already owns `deps`).

Logger availability: `deps` does not currently carry a `logger`. Two options, pick one in tasks:
(a) add `readonly logger: pino.Logger` to `AppDeps` and thread it from `main.ts` (cleanest, reusable
by `runAiReply` for tool audit too); (b) construct a module-level pino in the route. **Recommended:
(a)** — `runAiReply` and `executeTool` need a logger for pino audit anyway, so put it on `AppDeps`.

## D4/D5 — Tool registry

`apps/backend/src/ai/tool-registry.ts`. Each tool is a typed object; the registry array IS the
allowlist handed to the LLM. The LLM never receives a function reference — only name + JSON schema.

```ts
export type AiTool<I, O> = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;   // Zod = single source of truth (validates + → JSON Schema)
  /** Executes the capability. Receives deps + tenantId; runs withTenant. NEVER gets raw model text. */
  readonly run: (deps: AppDeps, tenantId: string, input: I) => Promise<Result<O, ToolError>>;
};

export type ToolError =
  | { readonly code: 'TOOL_VALIDATION_ERROR'; readonly detail: string }
  | { readonly code: 'TOOL_EXEC_ERROR'; readonly cause?: unknown };
```

Two tools this slice (ai-agents.md §2.4 subset; both `requires_human_confirmation = false`):

```ts
// READ — returns business info from tenant_ai_config (NO DB write).
export const getBusinessInfo: AiTool<Record<string, never>, BusinessInfo> = {
  name: 'getBusinessInfo',
  description: 'Devuelve nombre, info y horarios del negocio del tenant.',
  inputSchema: z.object({}).strict(),
  run: async (deps, tenantId) => {
    const cfg = await getTenantAiConfig(deps.db.withTenant, tenantId);
    // map cfg.businessName + cfg.businessInfo → BusinessInfo; pino-audit
  },
};

// WRITE — governed classify into the Corte-1 contact columns (intent + tags + intent_confidence).
export const classifyContact: AiTool<ClassifyInput, ClassifyOutput> = {
  name: 'classifyContact',
  description: 'Clasifica la intención del cliente y le asigna etiquetas.',
  inputSchema: z.object({
    contactId: z.string().uuid(),
    intent: z.enum(['ver_catalogo', 'hacer_pedido', 'consultar_precio', 'estado_pedido', 'otro']),
    tags: z.array(z.string()).max(10).default([]),
    intentConfidence: z.number().min(0).max(1).optional(),
  }).strict(),
  run: async (deps, tenantId, input) => {
    // reuse the existing contacts repo update under withTenant (RLS), pino-audit the call
    const repo = createContactsRepository(deps.db.withTenant, tenantId);
    return repo.update(input.contactId, {
      intent: input.intent,
      tags: input.tags,
      ...(input.intentConfidence !== undefined ? { intentConfidence: input.intentConfidence } : {}),
    });
  },
};
```

The intent enum is the `tienda_general` set from ai-agents.md §3 (`ver_catalogo`, `hacer_pedido`,
`consultar_precio`, `estado_pedido`) plus `otro` for out-of-scope.

Executor — maps an LLM `ToolUseBlock` to a registered tool, validates, runs, audits, and shapes the
`tool` result message back to the model:

```ts
export const executeTool = async (
  deps: AppDeps,
  tenantId: string,
  block: ToolUseBlock,
): Promise<LlmMessage /* role:'tool' */> => {
  const tool = REGISTRY.find((t) => t.name === block.name);
  if (!tool) {
    deps.logger.warn({ name: block.name }, '[ai-tool] unknown tool requested (not in allowlist)');
    return { role: 'tool', toolUseId: block.id, content: JSON.stringify({ error: 'unknown_tool' }) };
  }
  const parsed = tool.inputSchema.safeParse(block.input);
  if (!parsed.success) {
    deps.logger.warn({ name: block.name }, '[ai-tool] input validation failed');
    return { role: 'tool', toolUseId: block.id, content: JSON.stringify({ error: 'invalid_input' }) };
  }
  const result = await tool.run(deps, tenantId, parsed.data);
  deps.logger.info(
    { tool: block.name, tenantId, status: result.ok ? 'ok' : 'error' },
    '[ai-tool] invocation', // pino audit (ai.invocation_log table is OUT of scope — pino only)
  );
  return {
    role: 'tool',
    toolUseId: block.id,
    content: JSON.stringify(result.ok ? result.value : { error: result.error.code }),
  };
};
```

Audit note: ai-agents.md §2.2 specifies an `ai.invocation_log` table. This slice does pino-only
audit (proposal non-goal). The pino shape above is the forward-compatible record (tool, tenant,
status); the table is a later slice.

## D6 — Migration `0004_tenant_ai_config.sql`

Drizzle schema TS (`apps/backend/src/db/schema/tenant-ai-config.schema.ts`) mirrors the
`whatsapp-accounts` pattern: `pgTable` + domain type + `mapRow`. Columns from the proposal:

```ts
export const tenantAiConfigTable = pgTable('tenant_ai_config', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  vertical: text('vertical').notNull(),                 // 'tienda_general' this slice
  businessName: text('business_name').notNull(),
  businessInfo: jsonb('business_info').notNull().default(sql`'{}'::jsonb`),
  enabled: boolean('enabled').notNull().default(false),
  systemPromptOverride: text('system_prompt_override'), // nullable
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});
```

SQL DDL — carries the drizzle-kit RLS-erase warning header; hand-written RLS + grant block at the
end (same shape as `0002_whatsapp.sql`'s `tenant_isolation` for `app_rls`). One live row per tenant
enforced by a partial unique index on `tenant_id WHERE deleted_at IS NULL`.

```sql
-- 0004_tenant_ai_config.sql
-- Per-tenant AI agent config (vertical, business info, enable flag, prompt override).
--
-- WARNING: Re-running `pnpm drizzle-kit generate` will OVERWRITE this file and
-- ERASE the RLS + grant block below. After re-generating, re-append everything
-- from the "-- RLS + grant block" section to end of file.

CREATE TABLE IF NOT EXISTS "tenant_ai_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "vertical" text NOT NULL,
  "business_name" text NOT NULL,
  "business_info" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled" boolean NOT NULL DEFAULT false,
  "system_prompt_override" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz
);

-- One live config per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_ai_config_tenant_uq"
  ON "tenant_ai_config" ("tenant_id") WHERE deleted_at IS NULL;

-- =============================================================================
-- RLS + grant block (hand-written; drizzle-kit cannot emit policies or grants).
-- Re-append this entire section after any drizzle-kit regeneration.
-- =============================================================================

ALTER TABLE "tenant_ai_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_ai_config" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "tenant_ai_config";
CREATE POLICY tenant_isolation ON "tenant_ai_config" TO app_rls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Least privilege: app_rls reads + writes; app_webhook gets NOTHING (not a config-lookup table).
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_ai_config" TO app_rls;
```

Wiring:
- Append `'0004_tenant_ai_config.sql'` to `MIGRATION_FILES` in BOTH `src/db/migrate.ts:39` and
  `test/_helpers/test-db.ts:60`.
- Add `tenant_ai_config` to the `TRUNCATE` list in `test-db.ts` (truncate it before contacts; no FK
  to contacts so order is flexible — put it first).
- `seed-dev.ts`: after the `whatsapp_accounts` insert, `INSERT ... ON CONFLICT DO NOTHING` one
  enabled `tienda_general` row for `DEV_TENANT_ID` (`enabled = true`, a sample `business_name`,
  `business_info` JSON with horarios/productos). Idempotent like the existing account seed.

`tenant-ai-config.repository.ts` — single read helper (no write surface this slice; config is
seed/manual):

```ts
export const getTenantAiConfig = async (
  withTenant: TenantRunner,
  tenantId: string,
): Promise<Result<TenantAiConfig | null, { code: 'DB_ERROR'; cause?: unknown }>> =>
  withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(tenantAiConfigTable)
      .where(isNull(tenantAiConfigTable.deletedAt)).limit(1);   // RLS scopes to tenant — NO WHERE tenant_id
    return ok(rows[0] ? mapRowToTenantAiConfig(rows[0]) : null);
  });
```

## D7 — Env + dev fake-LLM gating

`config/env.ts` — add two vars using the existing patterns (NO `z.coerce.boolean`):

```ts
// AI — Anthropic. OPTIONAL: when unset, the AI loop is inert (skips with NO_API_KEY logged).
// Optional (not .min(1)) so dev/CI without a key still boots; the gate below decides real vs fake.
ANTHROPIC_API_KEY: z.string().optional(),
// Model id. Default = claude-haiku-4-5 (cheap/fast for store FAQ + classification).
AI_MODEL: z.string().min(1).default('claude-haiku-4-5'),
```

`main.ts` — compose the adapter exactly like `meta` (gate on `ENABLE_DEV_ENDPOINTS`):

```ts
const llm = env.ENABLE_DEV_ENDPOINTS
  ? createFakeLlmAdapter()                              // dev console works without a real key
  : createAnthropicAdapter(env.ANTHROPIC_API_KEY ?? '', env.AI_MODEL); // prod path
const app = buildApp({ db, env, meta, llm, logger });
```

Rationale for gating the fake on `ENABLE_DEV_ENDPOINTS`: it mirrors the existing `meta` decision in
`main.ts:29-31`, so `dev-local.mjs` (which sets `ENABLE_DEV_ENDPOINTS=true` and dummy secrets) gets
a deterministic fake LLM and needs NO real key — the dev console keeps working end-to-end. In prod
(`ENABLE_DEV_ENDPOINTS` unset) the real adapter is used; if `ANTHROPIC_API_KEY` is empty there, the
adapter returns `LLM_API_ERROR` and `runAiReply` skips gracefully (no crash).

`dev-local.mjs` change: optional — add `AI_MODEL` for completeness, but NO real
`ANTHROPIC_API_KEY` is needed because the fake adapter is selected. Document this in `.env.example`.

## D8 — System prompt

`buildTiendaGeneralSystemPrompt(config)` returns the ai-agents.md §5 base prompt with `{}`
placeholders resolved from `config` (business name, vertical label, intent list for
`tienda_general`). The customer's message is NEVER concatenated here — it stays as a `user` message.
If `config.systemPromptOverride` is set, it replaces the base (tenant escape hatch); otherwise the
immutable per-vertical base is used. The out-of-scope fallback menu (spec §4) is built from the same
config for the loop-exhaustion path.

## Conversation history helper

`whatsapp-messages.repository.ts` gains `getConversationHistory`:

```ts
export const getConversationHistory = (
  withTenant: TenantRunner,
  tenantId: string,
  contactId: string,
  limit = 10,
): Promise<LlmMessage[]> =>
  withTenant(tenantId, async (tx) => {
    const rows = await tx.select({ text: textBody, direction, receivedAt })
      .from(whatsappMessagesTable)
      .where(eq(whatsappMessagesTable.contactId, contactId))  // RLS scopes tenant; contactId narrows
      .orderBy(desc(receivedAt)).limit(limit);
    // reverse to chronological; map inbound→'user', outbound→'assistant'; drop null text bodies
  });
```

RLS still scopes to the tenant (no `WHERE tenant_id`); the `contactId` predicate only narrows within
the already-tenant-scoped rows. The 24h-window check reuses the same table:
`MAX(received_at) WHERE direction='inbound'` for the contact, compared to `now() - interval '24 hours'`.

## Test strategy (Strict TDD)

| Layer | What | How |
|-------|------|-----|
| Unit — orchestrator | enabled/disabled, window open/closed, tool-call loop (0/1/many/max-5), LLM error → skip, send error → err | `createFakeLlmAdapter(script)` + `createFakeMetaClient` + a fake/in-memory config + history; no DB |
| Unit — tool registry | unknown tool, Zod-invalid input, getBusinessInfo maps config, classifyContact calls repo.update with right patch | mock the contacts repo / config repo; assert pino audit shape |
| Unit — adapter | Anthropic content-block → `LlmResponse` mapping; fake adapter dequeues script + records calls | pure mapping tests; no network |
| Integration (Testcontainers) | `tenant_ai_config` RLS isolation (tenant A cannot read tenant B), `getTenantAiConfig`, `classifyContact` write under `withTenant`, 24h-window query, `getConversationHistory` ordering | `createTestDb()` with `0004` applied; seed two tenants |
| Env | `ANTHROPIC_API_KEY` optional, `AI_MODEL` default, fake-vs-real selection by `ENABLE_DEV_ENDPOINTS` | env parse tests + main composition smoke |

Web has no tests (per init). The fake LLM is the key seam: it makes the entire governed loop
deterministic without a network call or a real key.

## Checklist (reviewer can confirm)

- [ ] `LlmAdapter.complete(system, messages, tools)` returns `Result<LlmResponse, LlmError>`; real + fake; no Anthropic types leak into the orchestrator.
- [ ] `runAiReply` returns `Result`, never throws; fire-and-forget in the route with top-level `.catch`; ack-fast 200 unchanged.
- [ ] LLM receives NO DB handle; only registry tools execute, each Zod-validated and pino-audited.
- [ ] `0004_tenant_ai_config.sql` has RLS `tenant_isolation` + `GRANT ... app_rls` + the drizzle-kit warning header; appended to `MIGRATION_FILES` in both `migrate.ts` and `test-db.ts`.
- [ ] No `WHERE tenant_id` anywhere; all reads/writes via `withTenant`.
- [ ] Env: `ANTHROPIC_API_KEY` optional, `AI_MODEL` default; fake LLM gated on `ENABLE_DEV_ENDPOINTS` (explicit `'true'`).
- [ ] Customer text only ever in the `user` role; system prompt immutable per vertical.

## Next step

`sdd-tasks` — break this into ordered, testable units (TDD). The proposal flags a possible 2-PR
split: (PR1) migration + seed + LlmAdapter interface/fakes + env wiring; (PR2) tool registry +
`runAiReply` + webhook trigger + integration tests.
