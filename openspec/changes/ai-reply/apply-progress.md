# Apply Progress: ai-reply — Lote 0 (Gemini provider swap)

> Branch: `feat/ai-reply-runtime` | Worktree: `sivi-whatsapp-hub.worktrees/ai-reply-runtime`
> Completed: 2026-06-26 | Mode: Strict TDD

## TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR | Notes |
|------|-----|-------|----------|-------|
| 3.4 Gemini adapter | `bf81382` — 5 tests failing | `aa9825a` — 11/11 pass | Biome auto-fix on commit | Stub-injected, no real API |
| 2.1 env GEMINI_API_KEY | — (structural, no test) | `6c729c3` | — | AI_MODEL default → gemini-2.5-flash |
| 4.2 main.ts Gemini wire | — (structural, no test) | `6c729c3` | — | createGeminiAdapter replaces Anthropic default |
| 12.1 .env.example | — (docs, no test) | `6c729c3` | — | GEMINI_API_KEY + AI_MODEL documented |

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

## Known Constraints / Risks

1. **`tool` role LlmMessage → Gemini functionResponse**: Gemini requires the function `name` in
   `functionResponse`, but `LlmMessage` (role='tool') only carries `toolUseId` (not name). The adapter
   uses `toolUseId` as a placeholder for `name`. The `runAiReply` orchestrator (PR2) MUST track the
   function name alongside the toolUseId when building multi-turn conversations.

2. **`@google/genai` version 2.10.0**: API surface verified against installed `dist/genai.d.ts`.
   SDK uses `parametersJsonSchema` (not `parameters`) for JSON Schema objects — confirmed correct.

## Remaining Tasks (Lote A/B/C = PR2)

Phases 5–12 (minus 12.1 already done): conversation history, tenant-ai-config repo,
system-prompt builder, tool registry, runAiReply orchestrator, webhook trigger, E2E test,
final typecheck gate.
