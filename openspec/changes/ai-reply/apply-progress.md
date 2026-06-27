# Apply Progress: ai-reply — Lote A (data layer — Phases 5 + 6)

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

## Known Constraints / Risks

1. **`tool` role LlmMessage → Gemini functionResponse**: Gemini requires the function `name` in
   `functionResponse`, but `LlmMessage` (role='tool') only carries `toolUseId` (not name). The adapter
   uses `toolUseId` as a placeholder for `name`. The `runAiReply` orchestrator (PR2) MUST track the
   function name alongside the toolUseId when building multi-turn conversations.

2. **`@google/genai` version 2.10.0**: API surface verified against installed `dist/genai.d.ts`.
   SDK uses `parametersJsonSchema` (not `parameters`) for JSON Schema objects — confirmed correct.

3. **getConversationHistory only returns inbound messages**: Design intent is inbound-only for Lote A.
   Lote B (runAiReply) will extend to include outbound (assistant) messages for proper multi-turn context.

## Remaining Tasks (Lote B/C = PR2 continued)

Phases 7–12 (minus 12.1 already done): system-prompt builder, tool registry, runAiReply orchestrator,
handleInboundMessage extension, webhook trigger, E2E integration test, final typecheck gate.
