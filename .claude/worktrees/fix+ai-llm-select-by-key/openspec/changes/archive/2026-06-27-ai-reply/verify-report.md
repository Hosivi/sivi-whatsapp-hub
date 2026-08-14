# Verify Report: ai-reply — Governed AI auto-reply + auto-classify

> Change: ai-reply | Mode: hybrid | TDD: Strict
> Worktree: `sivi-whatsapp-hub.worktrees/ai-reply-runtime` | Branch: `feat/ai-reply-runtime` | HEAD: `e89f894`
> Main HEAD: `9d5e826` (unchanged — verify never touched the main checkout)
> Verified: 2026-06-27

## Verdict: PASS — ready for PR + archive

- CRITICAL: 0
- WARNING: 0
- SUGGESTION: 2

All 35/35 tasks complete and mapped to real code. 395/395 tests green, typecheck clean.
Every spec requirement has a real implementation backed by a passing test. The four
high-stakes governance invariants hold across the integrated whole.

## Build / Tests / Typecheck evidence

| Command | Result |
|---|---|
| `pnpm --filter @sivihub/contracts build` | OK (tsc clean — fresh-worktree prereq) |
| `pnpm --filter @sivihub/whatsapp-hub-backend test` | **395 passed / 395** across **40 test files** (117.43s) |
| `pnpm --filter @sivihub/whatsapp-hub-backend typecheck` | OK — `tsc --noEmit` clean, 0 errors |

## Spec → implementation traceability

| Spec requirement | Implementation | Test evidence | Status |
|---|---|---|---|
| Conversation context fetch (inbound-only, ≤10, chronological) | `whatsapp-messages.repository.ts::getConversationHistory` | `test/ai/whatsapp-messages.repo.int.test.ts` | COVERED |
| 24h service window (MAX(received_at) inbound, DB NOW(), no-rows→closed) | `ai-reply.service.ts::isWithin24hServiceWindow` | same int test (5.3/5.4) | COVERED |
| LlmAdapter interface (real + fake) | `llm-adapter.ts` — Gemini (active) + Anthropic (retained) + fake | `test/ai/llm-adapter.unit.test.ts` (11) | COVERED |
| System prompt (template + override verbatim, no customer text) | `system-prompt.ts::buildTiendaGeneralSystemPrompt` | `test/ai/system-prompt.unit.test.ts` (6) | COVERED |
| Tool registry governance (allowlist, Zod-before-execute, pino audit) | `tool-registry.ts` REGISTRY/executeTool/toLlmTool | `test/ai/tool-registry.unit.test.ts` (9) + `classify-contact.int.test.ts` (3) | COVERED |
| runAiReply gates + bounded loop + error containment | `ai-reply.service.ts::runAiReply` | `test/ai/ai-reply.service.unit.test.ts` (9) + `ai-reply.int.test.ts` (3) | COVERED |
| Ack-fast fire-and-forget (200 before AI; AI errors isolated) | `webhooks/whatsapp.route.ts` (`void runAiReply().catch`) | `whatsapp.route.int` + `whatsapp-send.int` | COVERED |
| RLS via withTenant (no WHERE tenant_id) | all repos: conv-history, tenant-ai-config, classifyContact | RLS isolation int tests (tenant A vs B) | COVERED |
| No DB handle to LLM | `llm.complete(system, messages, tools)`; `ToolContext` has NO raw db (only `updateContact` + `config`) | unit "execute never called with DB handle" | COVERED |
| Secrets (apiKey never logged) | `createGeminiAdapter` / `createAnthropicAdapter` bind key to client only | unit "apiKey not in params" | COVERED |
| tenant_ai_config schema + RLS + dev seed | `0004_tenant_ai_config.sql` + schema + `seed-dev.ts` | `tenant-ai-config.repo.int.test.ts` (7) | COVERED |
| Env: GEMINI_API_KEY optional, AI_MODEL default, ANTHROPIC retained | `config/env.ts` | env parse + main wiring | COVERED |

No spec requirement is left uncovered.

## Task completion

tasks.md = **35/35 checked**. Each checked task maps to code on disk (Phases 1–12).
apply-progress (Lotes 0/A/B/C) records the RED→GREEN TDD cycle with commit hashes per task.

## Governance re-confirm (high-stakes, integrated whole)

| Invariant | Evidence | Holds |
|---|---|---|
| LLM cannot write/send on its own — only via Zod-validated, audited tools | `executeTool`: registry lookup → `safeParse` BEFORE `run` → pino `ai_tool_invocation`; unknown tool / invalid input return an error message, never execute | YES |
| Bounded 5-iteration loop | `runAiReply` `MAX_ITERATIONS = 5`; exhaustion → `ai_tool_limit_reached` warn + `err(LLM_FAILED)`, NO reply | YES |
| runAiReply never throws (Result) | top-level try/catch → `DB_ERROR`; inner try/catch around `llm.complete`; all paths return `Result` | YES |
| Ack-fast (200 before AI) | route returns `c.text('ok', 200)`; `runAiReply` fired with `void ... .catch()`, never awaited; AI errors cannot reach the HTTP response | YES |

No cross-batch regression: the integrated suite (395) exercises all four invariants end-to-end.

## Provider wiring (Gemini active, Anthropic retained)

Consistent across all three layers:
- `env.ts`: `GEMINI_API_KEY: z.string().optional()`, `AI_MODEL` default `'gemini-2.5-flash'`, `ANTHROPIC_API_KEY` retained optional.
- `main.ts`: `ENABLE_DEV_ENDPOINTS ? createFakeLlmAdapter() : createGeminiAdapter(env.GEMINI_API_KEY ?? '', env.AI_MODEL)`.
- `llm-adapter.ts`: `createGeminiAdapter` via `@google/genai` (active default); `createAnthropicAdapter` via `@anthropic-ai/sdk` (retained, not wired). apiKey never logged in either.
- `.env.example`: documents both keys + `AI_MODEL=gemini-2.5-flash`.

The AI_MODEL default deviates from design.md (`claude-haiku-4-5`) intentionally — the documented
Lote 0 provider swap to Gemini. Tasks.md and apply-progress record the swap. Not a defect.

## Findings

### SUGGESTION 1 — System prompt references tools not in the slice allowlist
`system-prompt.ts` instructs the model to "invocás escalateToHuman" and to generate payment links /
issue comprobantes. Those tools are out-of-scope for this slice (allowlist = `getBusinessInfo`,
`classifyContact`). If the model tries `escalateToHuman`, `executeTool` returns `unknown_tool` and the
loop can run to its 5-iteration cap → silent no-reply. This matches the spec's "no escalateToHuman in
slice #1 / loop exhaustion → no reply" intent, but the prompt actively steers the model toward a
dead-end. Consider trimming the prompt to only reference registered tools to avoid wasted iterations
and silent non-responses. Non-blocking.

### SUGGESTION 2 — design.md history mapping is stale vs the implemented spec
design.md §D2 / "Conversation history helper" describe mapping outbound → `assistant`. The spec
(authoritative) says outbound is EXCLUDED for prompt-injection safety, and the implementation
correctly excludes outbound (inbound-only → `user`). The code follows the spec; design.md is simply
out of date. Cosmetic — refresh design.md on archive if desired. Non-blocking.

## Next

`sdd-archive` — change is clean and ready for PR.
