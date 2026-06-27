# Archive Report — ai-reply (SDD Cycle Complete)

> Change: ai-reply — Governed AI auto-reply + auto-classify (Corte 2 slice #1)
> Status: CLOSED
> Date archived: 2026-06-27
> Verify verdict: **PASS** (CRITICAL: 0, WARNING: 0, SUGGESTION: 2)

---

## Executive Summary

The **ai-reply** change has been fully planned, implemented, verified, and is now archived. The first governed AI loop is production-ready: WhatsApp inbound messages from store customers now receive AI-powered replies using tenant-configured business info, and contacts are auto-classified with `intent` + `tags`. The change spans 35 tasks delivered across 2 chained PRs (Lote 0 + Lotes A/B/C), with 395 passing tests (up from 340 baseline) and zero CRITICAL verification issues. All spec requirements have implementation backed by passing tests. The system provably enforces governed AI execution (LLM can only invoke registered, Zod-validated, audited tools) and ack-fast fire-and-forget delivery (200 returned before AI runs).

---

## Change Summary

| Aspect | Detail |
|--------|--------|
| **Change ID** | `ai-reply` |
| **Corte** | 2 (slice #1 of 5) |
| **Proposal** | `sdd/ai-reply/proposal` |
| **Spec** | `sdd/ai-reply/spec` (delta specs synced to canonical) |
| **Design** | `sdd/ai-reply/design` |
| **Tasks** | `sdd/ai-reply/tasks` — 35/35 complete |
| **Apply progress** | Phases 1–12, all tasks checked (Lotes 0/A/B/C) |
| **Verify report** | `sdd/ai-reply/verify-report` — PASS |
| **Main branch** | Merged PR #7 (`feat/dialog360-adapter`) includes ai-reply foundation; see prior PRs #3–#5 |
| **Worktree** | `sivi-whatsapp-hub.worktrees/ai-reply-runtime`, branch `feat/ai-reply-runtime` |

---

## Capabilities Delivered

### 1. **ai-reply** — Governed Async AI Reply Loop

**What shipped:**
- Fire-and-forget async reply pipeline triggered AFTER webhook acks 200 (ack-fast preserved).
- Gated by tenant AI config state (enabled/disabled, soft-delete).
- 24h service window enforcement (customer wrote first within 24h = consent).
- Conversation context fetch (~10 recent inbound messages only, no outbound).
- System prompt construction using `tienda_general` template with tenant business info.
- Bounded tool-call loop (max 5 iterations before giving up silently).
- Fire-and-forget reply send via existing `sendWhatsappText`, with full error containment.
- All errors logged via pino (never thrown to caller); no unhandled rejections.

**Tasks:** 35/35 (Phases 1–12)

**Test coverage:** 395/395 passing (40 test files)

**Key invariants verified:**
- LLM never receives DB handle; only registered tools execute.
- Zod-validated input before tool execution; invalid input returns error to LLM.
- Pino audit per tool call (tool name, status, tenant ID).
- No `WHERE tenant_id` — RLS via `withTenant` only.
- Ack-fast 200 sent before AI runs.

---

### 2. **ai-tool-registry** — Typed Functional-DI Tool Registry

**What shipped:**
- `AiTool<I, O>` interface: name, description, inputSchema (Zod), run function.
- Two slice-#1 tools:
  - **getBusinessInfo**: READ from pre-loaded tenant AI config (no DB query).
  - **classifyContact**: WRITE `intent` + `tags` + `intent_confidence` to contact via contacts repo.
- Tool executor: registry lookup → Zod validation → execution → pino audit.
- Unknown tool/invalid input return error messages to LLM (no execute, no crash).
- Allowlist enforced: LLM receives only `[getBusinessInfo, classifyContact]` for `tienda_general`.

**Tasks:** 8 (Phases 6–8)

**Test coverage:** 12 test cases (unit + integration, RLS isolation verified)

**Key invariants verified:**
- Zod validation before execution.
- No DB handle passed to tools.
- RLS isolation (tenant A cannot read/write tenant B's data).
- Pino audit per invocation.

---

### 3. **tenant-ai-config** — Per-Tenant AI Configuration

**What shipped:**
- Migration `0004_tenant_ai_config.sql`: table schema, RLS `tenant_isolation` policy, grant `app_rls`.
- Columns: `id` (PK), `tenant_id`, `vertical`, `business_name`, `business_info` (JSONB), `enabled` (default true), `system_prompt_override` (nullable), soft-delete.
- Dev seed: one `tienda_general` row for dev tenant (idempotent).
- Repository function: `getTenantAiConfig(withTenant, tenantId)` — returns ok(null) if disabled/missing/soft-deleted, ok(row) if one active, err(MULTIPLE_CONFIGS) if many.
- Drizzle schema + domain type + row mapper.

**Tasks:** 9 (Phases 1–2, 6)

**Test coverage:** 7 test cases (RLS isolation, dev seed idempotency, read contract)

**Key invariants verified:**
- No `WHERE tenant_id` — RLS scopes all operations.
- Unique index ensures one live config per tenant per vertical.
- Soft-delete + `enabled` flag control activation.

---

## Implementation Evidence

### Build / Tests / Typecheck

| Command | Result |
|---|---|
| `pnpm --filter @sivihub/contracts build` | ✓ tsc clean |
| `pnpm --filter @sivihub/whatsapp-hub-backend test` | ✓ **395 passed / 395** (40 test files, 117.43s) |
| `pnpm --filter @sivihub/whatsapp-hub-backend typecheck` | ✓ tsc clean, 0 errors |

### Spec → Implementation Traceability

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
| No DB handle to LLM | `llm.complete(system, messages, tools)`; `ToolContext` has NO raw db | unit "execute never called with DB handle" | COVERED |
| Secrets (apiKey never logged) | `createGeminiAdapter` / `createAnthropicAdapter` bind key to client only | unit "apiKey not in params" | COVERED |
| tenant_ai_config schema + RLS + dev seed | `0004_tenant_ai_config.sql` + schema + `seed-dev.ts` | `tenant-ai-config.repo.int.test.ts` (7) | COVERED |
| Env: GEMINI_API_KEY optional, AI_MODEL default, ANTHROPIC retained | `config/env.ts` + `main.ts` wiring | env parse + main composition | COVERED |

### Governance Invariants (Integrated Whole)

All four high-stakes invariants hold across the entire 395-test suite:

| Invariant | Evidence | Status |
|---|---|---|
| LLM cannot write/send on its own — only via Zod-validated, audited tools | `executeTool`: registry lookup → `safeParse` BEFORE `run` → pino audit; unknown tool / invalid input return error message, never execute | HOLDS |
| Bounded 5-iteration loop | `runAiReply` `MAX_ITERATIONS = 5`; exhaustion → `ai_tool_limit_reached` warn + `err(LLM_FAILED)`, NO reply | HOLDS |
| runAiReply never throws (Result) | top-level try/catch → `DB_ERROR`; inner try/catch around `llm.complete`; all paths return `Result` | HOLDS |
| Ack-fast (200 before AI) | route returns `c.text('ok', 200)`; `runAiReply` fired with `void ... .catch()`, never awaited; AI errors cannot reach the HTTP response | HOLDS |

---

## Verification Verdict

**Status: PASS** — Ready for production deployment.

- CRITICAL: 0
- WARNING: 0
- SUGGESTION: 2 (non-blocking)

### Suggestions (Non-Blocking)

**SUGGESTION 1 — System prompt references tools not in the slice allowlist**

The generated `tienda_general` system prompt instructs the model to invoke `escalateToHuman` and to generate payment links / issue comprobantes. Those tools are out-of-scope for this slice (allowlist = `getBusinessInfo`, `classifyContact`). If the model tries any of them, `executeTool` returns `unknown_tool` and the loop can run to its 5-iteration cap → silent no-reply. This matches the spec's "no escalateToHuman in slice #1 / loop exhaustion → no reply" intent, but the prompt actively steers the model toward dead-ends. **Recommendation:** Trim the prompt to only reference registered tools to avoid wasted iterations and silent non-responses. **Blocking:** No — loop terminates gracefully, no crash, no data loss. **Action:** Consider for next maintenance window.

**SUGGESTION 2 — design.md history mapping is stale vs the implemented spec**

The design doc (§D2) describes conversation history helper mapping as inbound→`user`, outbound→`assistant`. The spec (authoritative) says outbound is EXCLUDED for prompt-injection safety, and the implementation correctly excludes outbound (inbound-only → `user`). The code follows the spec; design.md is simply out of date. **Blocking:** No — cosmetic documentation drift. **Action:** Refresh design.md on next archive cycle if desired.

---

## Delivery Summary

| Phase | PR | Tasks | Focus | Status |
|-------|----|----|-----|--------|
| 1 | PR 1 | 5 | Migration + schema + MIGRATION_FILES wiring | ✓ Complete |
| 2 | PR 1 | 2 | Env vars + dev seed | ✓ Complete |
| 3 | PR 1 | 5 | LlmAdapter interface + real (Gemini) + fake (TDD) | ✓ Complete |
| 4 | PR 1 | 4 | AppDeps + main.ts + all existing call sites | ✓ Complete |
| 5 | PR 2 | 4 | getConversationHistory + 24h window (TDD) | ✓ Complete |
| 6 | PR 2 | 2 | tenant-ai-config repository (TDD) | ✓ Complete |
| 7 | PR 2 | 2 | System prompt builder | ✓ Complete |
| 8 | PR 2 | 3 | Tool registry (TDD + integration) | ✓ Complete |
| 9 | PR 2 | 2 | runAiReply orchestrator (TDD) | ✓ Complete |
| 10 | PR 2 | 3 | handleInboundMessage extension + webhook trigger | ✓ Complete |
| 11 | PR 2 | 1 | End-to-end integration test | ✓ Complete |
| 12 | PR 2 | 2 | Docs + env example + final green gate | ✓ Complete |
| **Total** | **2 PRs** | **35** | | ✓ **COMPLETE** |

### Provider Wiring (Gemini Active, Anthropic Retained)

Consistent across all three layers per Lote 0 decision (provider swap from Anthropic proposal to Gemini implementation):

- **env.ts:** `GEMINI_API_KEY: z.string().optional()`, `AI_MODEL` default `'gemini-2.5-flash'`, `ANTHROPIC_API_KEY` retained optional.
- **main.ts:** `ENABLE_DEV_ENDPOINTS ? createFakeLlmAdapter() : createGeminiAdapter(env.GEMINI_API_KEY ?? '', env.AI_MODEL)`.
- **llm-adapter.ts:** `createGeminiAdapter` via `@google/genai` (active default); `createAnthropicAdapter` via `@anthropic-ai/sdk` (retained, not wired in prod). apiKey never logged in either.
- **.env.example:** documents both keys + `AI_MODEL=gemini-2.5-flash`.

The AI_MODEL default differs from design.md (`claude-haiku-4-5`) intentionally — Lote 0 provider swap documented in tasks.md and apply-progress. Not a defect; see apply-progress for context.

---

## Specs Synced to Canonical

The following delta specs have been merged into the main specification suite:

| Domain | Action | Requirement Count | Location |
|--------|--------|------|----------|
| `ai-reply` | CREATED | 9 | `openspec/specs/ai-reply/spec.md` |
| `ai-tool-registry` | CREATED | 5 | `openspec/specs/ai-tool-registry/spec.md` |
| `tenant-ai-config` | CREATED | 4 | `openspec/specs/tenant-ai-config/spec.md` |

All delta specs are marked ADDED (new capabilities, no prior specs to merge). Copied in full to canonical location. Ready for future slices to reference and extend.

---

## SDD Artifacts (Traceability)

All SDD artifacts are recorded for audit trail:

| Artifact | Topic Key | Engram Observation ID | Notes |
|---|---|---|---|
| Proposal | `sdd/ai-reply/proposal` | (recorded in verify phase) | Scope, decisions, approach |
| Spec | `sdd/ai-reply/spec` | (recorded in spec phase) | Delta capability specs |
| Design | `sdd/ai-reply/design` | (recorded in design phase) | Architecture, module layout, D1–D8 decisions |
| Tasks | `sdd/ai-reply/tasks` | (recorded in tasks phase) | 35 tasks, 2-PR delivery plan, TDD phases |
| Apply progress | `sdd/ai-reply/apply-progress` | (recorded in apply phase) | Lotes 0/A/B/C, RED→GREEN cycles, commit hashes |
| Verify report | `sdd/ai-reply/verify-report` | (recorded in verify phase) | PASS verdict, governance invariants, suggestions |
| Archive report | `sdd/ai-reply/archive-report` | (this file) | Closure, delivery summary, canonical specs location |

---

## Next Steps

The **ai-reply** SDD cycle is COMPLETE and CLOSED. The change is merged to main and production-ready.

### Immediate

- No action required. The change is fully archived and production-ready.

### For Corte 2 Continuation

- **Corte 2 slice #2** (if planned): Retry-safe queue (pg-boss outbox for fire-and-forget reliability).
- **Corte 3**: Money-moving tools (`createPaymentLink`, etc.) with `requires_human_confirmation` flag.
- **Corte 4**: Scheduling/appointment tools.

### For Maintenance

- Consider trimming system prompt references to in-scope tools only (SUGGESTION 1).
- Optionally refresh design.md for doc hygiene (SUGGESTION 2).

---

## Archive Checklist

- [x] All 35/35 tasks marked complete in persisted tasks artifact.
- [x] Verify report shows PASS (CRITICAL: 0).
- [x] 395/395 tests passing; typecheck clean.
- [x] All spec requirements traced to implementation + test.
- [x] Delta specs synced to canonical `openspec/specs/`.
- [x] No CRITICAL or outstanding issues.
- [x] Archive report written and persisted.
- [x] Ready for orchestrator to move change folder to archive.

---

**Archive Status: READY FOR CLOSURE**

The change is production-ready, fully verified, and archived.
