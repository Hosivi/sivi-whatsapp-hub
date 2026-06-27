# Apply Progress: ai-reply — Lote B (governed AI core — Phases 7 + 8 + 9 + carried fix)

> Branch: `feat/ai-reply-runtime` | Worktree: `sivi-whatsapp-hub.worktrees/ai-reply-runtime`
> Updated: 2026-06-27 | Mode: Strict TDD

## TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR | Notes |
|------|-----|-------|----------|-------|
| 3.4 Gemini adapter | `bf81382` — 5 tests failing | `aa9825a` — 11/11 pass | Biome auto-fix on commit | Stub-injected, no real API |
| 2.1 env GEMINI_API_KEY | — (structural, no test) | `6c729c3` | — | AI_MODEL default → gemini-2.5-flash |
| 4.2 main.ts Gemini wire | — (structural, no test) | `6c729c3` | — | createGeminiAdapter replaces Anthropic default |
| 12.1 .env.example | — (docs, no test) | `6c729c3` | — | GEMINI_API_KEY + AI_MODEL documented |
| 5.1–5.4 conversation history + 24h window | `313d35f` — import error | `864b653` — 11/11 pass | Biome auto-fix | getConversationHistory + isWithin24hServiceWindow |
| 6.1–6.2 tenant-ai-config repo | `a7281fc` — import error | `4da0ce8` — 7/7 pass | Biome auto-fix | getTenantAiConfig + RLS isolation |

## PR1 Reconciled

All Phase 1–4 tasks confirmed on disk and marked `[x]` in `openspec/changes/ai-reply/tasks.md`:
- 1.1 `@anthropic-ai/sdk` in package.json
- 1.2 `drizzle/0004_tenant_ai_config.sql`
- 1.3 `src/db/schema/tenant-ai-config.schema.ts`
- 1.4 `src/db/migrate.ts` MIGRATION_FILES
- 1.5 `test/_helpers/test-db.ts` MIGRATION_FILES + truncate
- 2.1 `env.ts` (updated to Gemini)
- 2.2 `seed-dev.ts` INSERT tenant_ai_config
- 3.1–3.5 `llm-adapter.ts` + `llm-types.ts` + unit tests (updated for Gemini)
- 4.1–4.4 `app.ts` AppDeps + `main.ts` wiring + call sites + green gate

## Lote 0 (Gemini Provider Swap) — DONE

### Tasks completed
- [x] Install `@google/genai@2.10.0` in `apps/backend/package.json`
- [x] 3.4 `createGeminiAdapter(apiKey, model, _testGenerateFn?)` in `apps/backend/src/ai/llm-adapter.ts`
  - Maps `LlmTool[]` → Gemini `functionDeclarations` via `parametersJsonSchema`
  - Maps `LlmMessage[]` → `Content[]` (user → 'user', assistant → 'model', tool → 'user'+functionResponse)
  - Maps Gemini `GenerateContentResponse` → `LlmResponse` (parts iteration, functionCall → ToolUseBlock)
  - `stopReason`: toolUses.length > 0 → 'tool_use'; MAX_TOKENS → 'max_tokens'; else 'end_turn'
  - Wraps all SDK errors into `LlmError { code: 'LLM_NETWORK_ERROR' }` without throwing
  - apiKey NEVER in generate call params (bound to GoogleGenAI client, not forwarded)
- [x] 3.5 5 new Gemini unit tests in `test/ai/llm-adapter.unit.test.ts` (all GREEN)
- [x] 2.1 `GEMINI_API_KEY: z.string().optional()` + `AI_MODEL` default → `'gemini-2.5-flash'`
- [x] 4.2 `main.ts` switched to `createGeminiAdapter(env.GEMINI_API_KEY ?? '', env.AI_MODEL)`
- [x] 12.1 `.env.example` documents `GEMINI_API_KEY` + `AI_MODEL=gemini-2.5-flash`
- [x] 4.4 Full suite: **345 tests pass** (340 baseline + 5 new Gemini tests)

### Commits (worktree `feat/ai-reply-runtime`)
- `bf81382` — test(ai-reply): add Gemini adapter unit tests RED (stub-injected)
- `aa9825a` — feat(ai-reply): add Gemini LLM adapter as active default (GREEN)
- `6c729c3` — feat(ai-reply): wire Gemini as active LLM provider, update env and .env.example

### Main repo commits
- `270901d` — chore(ai-reply): reconcile PR1 tasks and update Gemini provider in tasks.md

## Lote A (Data Layer — Phases 5 + 6) — DONE

### Tasks completed
- [x] 5.1 RED — `test/ai/whatsapp-messages.repo.int.test.ts` — 7 `getConversationHistory` tests + 4 `isWithin24hServiceWindow` tests
- [x] 5.2 GREEN — `getConversationHistory(withTenant, tenantId, contactId, limit?)` added to `whatsapp-messages.repository.ts`
  - SELECT text_body WHERE contact_id AND direction='inbound' AND text_body IS NOT NULL
  - ORDER BY received_at DESC LIMIT, then `.reverse()` to chronological
  - Maps to `LlmMessage[]` with role='user'; outbound dropped
  - No WHERE tenant_id — RLS only via withTenant
- [x] 5.3 RED — 24h window tests added to same test file
- [x] 5.4 GREEN — `isWithin24hServiceWindow(withTenant, tenantId, contactId)` created in `ai-reply.service.ts`
  - Single SQL query: `MAX(received_at) > NOW() - INTERVAL '24 hours'` with COALESCE(…, false)
  - Uses DB server time (NOW()) — avoids Node.js clock skew
  - Returns false when no inbound messages exist
- [x] 6.1 RED — `test/ai/tenant-ai-config.repo.int.test.ts` — 7 tests (null cases, enabled row, MULTIPLE_CONFIGS, RLS isolation)
- [x] 6.2 GREEN — `getTenantAiConfig(withTenant, tenantId)` created in `tenant-ai-config.repository.ts`
  - Filters: `deleted_at IS NULL AND enabled = true`
  - 0 rows → `ok(null)`; 1 row → `ok(row)`; >1 row → `err(MULTIPLE_CONFIGS)`
  - DB errors caught → `err(DB_ERROR, cause)`
  - No WHERE tenant_id — RLS only via withTenant

### Green gate: 363/363 tests pass; typecheck clean

### Commits (worktree `feat/ai-reply-runtime`)
- `313d35f` — test(ai-reply): getConversationHistory + isWithin24hServiceWindow RED
- `864b653` — feat(ai-reply): getConversationHistory + isWithin24hServiceWindow GREEN
- `a7281fc` — test(ai-reply): tenant-ai-config repository RED
- `4da0ce8` — feat(ai-reply): tenant-ai-config repository GREEN

### Discoveries
- **postgres.js raw SQL + Date objects**: Passing a JS Date to `rawSql\`...\`` template causes ERR_INVALID_ARG_TYPE. Must either use Drizzle's typed insert (for seeds) or keep all comparisons in SQL (for isWithin24hServiceWindow).
- **unique index on (tenant_id, vertical) WHERE deleted_at IS NULL**: Can't insert two active rows with same (tenant_id, vertical). MULTIPLE_CONFIGS test seeds two rows with DIFFERENT verticals.

## Lote B (Governed AI Core — Phases 7 + 8 + 9 + Carried Fix) — DONE

### Carried Design Fix

**Problem**: `LlmMessage` tool role had no `toolName` field. Gemini `functionResponse.name` was using `toolUseId` as placeholder — incorrect.
**Fix**: Added `toolName: string` to tool role; added `assistant-tool-use` variant; updated `mapGeminiMessages` to use `msg.toolName`.
**Test**: round-trip test (f) in `llm-adapter.unit.test.ts` proves `functionResponse.name === 'getBusinessInfo'` (not 'fc-001').

### Tasks completed
- [x] Carried fix: `toolName` + `assistant-tool-use` in `llm-types.ts` + `llm-adapter.ts` (commits `4fd4180` + `372aeab`)
- [x] 7.1 `apps/backend/src/ai/system-prompt.ts` — `buildTiendaGeneralSystemPrompt(config: TenantAiConfig): string`
  - Returns `systemPromptOverride` verbatim when non-null (D8 — no customer text in system)
  - Builds tienda_general template with business name + 4 intents from ai-agents.md §5
- [x] 7.2 `test/ai/system-prompt.unit.test.ts` — 6 unit tests (RED `ea389b6` → GREEN `16d81f0`)
- [x] 8.1 RED — `test/ai/tool-registry.unit.test.ts` (commit `cf919c4`, 9 governance gate tests)
  - `vi.mock('../../src/contacts/contacts.repository.js')` intercepts `createContactsRepository`
- [x] 8.2 GREEN — `apps/backend/src/ai/tool-registry.ts` (commit `853f005`)
  - `ToolContext`: `{ config, logger, updateContact }` — NO raw DB handle (D5)
  - `AiTool<I,O>`: `{ name, description, inputSchema: z.ZodType<I>, schema: Record<string,unknown>, run }`
  - `REGISTRY`: `[getBusinessInfoTool, classifyContactTool]`
  - `executeTool`: lookup → safeParse → build ctx → run → pino info `ai_tool_invocation` → role:'tool' LlmMessage
- [x] 8.3 `test/ai/classify-contact.int.test.ts` (commit `9802874`, 3 Testcontainers tests)
  - Postgres 16-alpine + all 5 migrations; RLS isolation verified; DB write verified via adminQuery
- [x] 9.1 RED — `test/ai/ai-reply.service.unit.test.ts` (commit `ea4a355`, 9 scenarios a-i)
  - `makeWindowStub(withinWindow)`: TenantRunner returning `[{within_window: bool}]`
  - `vi.mock()` for 4 external modules; dynamic import pattern
- [x] 9.2 GREEN — `apps/backend/src/ai/ai-reply.service.ts` (commit `52ca220`)
  - Full `runAiReply` with bounded loop (max 5), tool execution, pino audits
  - `AiReplyInput` / `AiReplyError` / `AiReplyOk` exported

### Green gate: 392/392 tests pass; typecheck clean (tsc --noEmit)
### Main HEAD: `9d5e826` (unchanged)

### Commits (worktree `feat/ai-reply-runtime`)
- `4fd4180` — test(ai-reply): add Gemini toolName round-trip test RED
- `372aeab` — fix(ai-reply): add toolName to LlmMessage tool role + assistant-tool-use variant + fix Gemini functionResponse.name
- `ea389b6` — test(ai-reply): system-prompt builder unit tests RED
- `16d81f0` — feat(ai-reply): buildTiendaGeneralSystemPrompt — tienda_general vertical system prompt (GREEN)
- `cf919c4` — test(ai-reply): tool registry unit tests RED (governance gates)
- `853f005` — feat(ai-reply): tool registry — getBusinessInfo, classifyContact, executeTool governance gate (GREEN)
- `9802874` — test(ai-reply): classify-contact integration tests — RLS isolation + DB write verification
- `ea4a355` — test(ai-reply): runAiReply orchestrator unit tests RED (9 scenarios)
- `52ca220` — feat(ai-reply): runAiReply orchestrator — governed LLM loop, tool execution, pino audits (GREEN)

### Discoveries
- No `zod-to-json-schema` available → dual schema pattern: `AiTool` has `inputSchema: z.ZodType<I>` (validation) AND `schema: Record<string,unknown>` (JSON Schema for LLM)
- `vi.mock()` at module level intercepts `createContactsRepository` cleanly
- `isWithin24hServiceWindow` cannot be `vi.mocked` (same file as `runAiReply`) → `makeWindowStub` TenantRunner pattern

## Known Constraints / Risks

1. **`@google/genai` version 2.10.0**: SDK uses `parametersJsonSchema` (not `parameters`) — confirmed correct.
2. **Phase 10-12 NOT YET IMPLEMENTED**: `runAiReply` not yet wired to the webhook route. AI does not fire on inbound messages yet.
3. **getConversationHistory only returns inbound messages**: Outbound assistant messages not yet included in LLM history.

## Remaining Tasks (Lote C = PR2 final)

- Phase 10: `handleInboundMessage` return shape extension + webhook trigger in `whatsapp.route.ts`
- Phase 11: E2E integration test (`test/ai/ai-reply.int.test.ts`, Testcontainers)
- Phase 12.2: `pnpm test` + typecheck final gate
