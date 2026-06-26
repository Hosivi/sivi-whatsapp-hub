# Tasks: ai-reply — Governed AI auto-reply + auto-classify

> Change: ai-reply | Artifact store: hybrid | TDD: Strict (test-first)
> Delivery strategy: ask-on-risk | Test runner: `pnpm --filter @sivihub/whatsapp-hub-backend test`

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~550–650 (prod ~280 + tests ~300) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 (see work units below) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending (user decision required) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Migration + Drizzle schema + env vars + `LlmAdapter` interface + `createAnthropicAdapter` + `createFakeLlmAdapter` + unit tests + `AppDeps.llm` + `main.ts` wiring + dev seed | PR 1 | Base = `feat/ai-reply`. Standalone: CI passes without PR 2. |
| 2 | `getConversationHistory` + `getTenantAiConfig` repo + `system-prompt.ts` + tool registry + `runAiReply` orchestrator + webhook trigger + all integration tests | PR 2 | Base = PR 1 branch (feature-branch-chain) or `feat/ai-reply` (stacked-to-main). |

---

## Phase 1: Dependency install + migration + schema (PR 1)

- [ ] 1.1 `pnpm add @anthropic-ai/sdk` (pinned to latest stable) in `apps/backend/package.json`; verify lockfile updates.
- [ ] 1.2 Create `apps/backend/drizzle/0004_tenant_ai_config.sql`: full DDL (table + partial unique index) + RLS `tenant_isolation` policy + `GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_ai_config" TO app_rls` + drizzle-kit regeneration warning header (mirror `0002_whatsapp.sql` pattern).
- [ ] 1.3 Create `apps/backend/src/db/schema/tenant-ai-config.schema.ts`: `tenantAiConfigTable` (`pgTable`) + `TenantAiConfig` domain type + `mapRowToTenantAiConfig` (mirror `whatsapp-accounts.schema.ts` pattern).
- [ ] 1.4 Append `'0004_tenant_ai_config.sql'` to `MIGRATION_FILES` in `apps/backend/src/db/migrate.ts:39`.
- [ ] 1.5 Append `'0004_tenant_ai_config.sql'` to `MIGRATION_FILES` in `apps/backend/test/_helpers/test-db.ts:60`; add `tenant_ai_config` to the `TRUNCATE` statement in `truncate()` (before `contacts`).

## Phase 2: Env + dev seed (PR 1, continued)

- [ ] 2.1 Add to `apps/backend/src/config/env.ts`: `ANTHROPIC_API_KEY: z.string().optional()` and `AI_MODEL: z.string().min(1).default('claude-haiku-4-5')` — use explicit string gate, NOT `z.coerce.boolean()`.
- [ ] 2.2 Update `apps/backend/src/db/seed-dev.ts`: after the `whatsapp_accounts` insert, add `INSERT INTO tenant_ai_config (...) VALUES (...) ON CONFLICT DO NOTHING` for `DEV_TENANT_ID` with `vertical = 'tienda_general'`, `enabled = true`, sample `business_name` and `business_info` JSONB (products + hours). Idempotent.

## Phase 3: LlmAdapter interface + real + fake (PR 1, TDD)

- [ ] 3.1 **RED** — Write unit test `apps/backend/test/ai/llm-adapter.unit.test.ts`: fake adapter dequeues programmed responses + records calls; default returns `ok({ text: 'fake reply', toolUses: [], stopReason: 'end_turn' })`; queue is exhausted → wraps around to default.
- [ ] 3.2 Create `apps/backend/src/ai/llm-types.ts`: `LlmMessage`, `LlmTool`, `ToolUseBlock`, `LlmResponse`, `LlmError` (provider-neutral shapes; no Anthropic imports).
- [ ] 3.3 **GREEN** — Create `apps/backend/src/ai/llm-adapter.ts`: `LlmAdapter` interface (`complete(system, messages, tools): Promise<Result<LlmResponse, LlmError>>`); `createFakeLlmAdapter(script?)` with `calls` recorder + `queueResponse()` — make 3.1 pass.
- [ ] 3.4 Add `createAnthropicAdapter(apiKey, model): LlmAdapter` to `llm-adapter.ts`: maps Anthropic content blocks → `LlmResponse`; NEVER logs `apiKey`; wraps Anthropic SDK errors into `LlmError` without throwing.
- [ ] 3.5 **RED** — Extend test 3.1: `createAnthropicAdapter` TypeScript compilation succeeds (type-check only; no real API call in unit tests).

## Phase 4: AppDeps + main.ts wiring (PR 1)

- [ ] 4.1 Add `readonly llm: LlmAdapter` and `readonly logger: pino.Logger` to `AppDeps` in `apps/backend/src/app.ts`; update JSDoc.
- [ ] 4.2 Update `apps/backend/src/main.ts`: instantiate `llm` with the same `ENABLE_DEV_ENDPOINTS` gate as `meta` (`createFakeLlmAdapter()` vs `createAnthropicAdapter(env.ANTHROPIC_API_KEY ?? '', env.AI_MODEL)`); pass `llm` and `logger` to `buildApp({ db, env, meta, llm, logger })`.
- [ ] 4.3 Update ALL existing `buildApp(...)` call sites to pass `llm: createFakeLlmAdapter()` and a `logger` stub (e.g. `pino({ level: 'silent' })`). Files:
  - `apps/backend/test/dev/webhook-sign.route.int.test.ts` (8 call sites)
  - `apps/backend/test/contacts/contacts.import.int.test.ts` (1 call site)
  - `apps/backend/test/contacts/contacts.route.int.test.ts` (6 call sites)
  - `apps/backend/test/contacts/contacts.routing.int.test.ts` (1 call site)
  - `apps/backend/test/whatsapp-send/whatsapp-send.int.test.ts` (4 call sites)
  - `apps/backend/test/whatsapp-messages/whatsapp-messages.route.int.test.ts` (1 call site)
  - `apps/backend/test/webhooks/whatsapp.route.int.test.ts` (2 call sites)
  - `apps/backend/test/webhooks/whatsapp.stub.test.ts` (2 call sites)
  - `apps/backend/test/whatsapp-send/whatsapp-send.route.unit.test.ts` (1 call site)
  - `apps/backend/src/main.ts` — handled by 4.2.
- [ ] 4.4 **Run** `pnpm --filter @sivihub/whatsapp-hub-backend test` — all pre-existing tests must still pass (PR 1 green gate).

---

## Phase 5: Conversation history + 24h window query (PR 2)

- [ ] 5.1 **RED** — Write integration test `apps/backend/test/ai/whatsapp-messages.repo.int.test.ts` using `createTestDb()`: `getConversationHistory` returns inbound-only messages as `LlmMessage[]` in chronological order; capped at `limit`; empty when no inbound messages exist; RLS scopes to tenant.
- [ ] 5.2 **GREEN** — Add `getConversationHistory(withTenant, tenantId, contactId, limit?)` to `apps/backend/src/whatsapp-messages/whatsapp-messages.repository.ts`: SELECT `text_body`, `direction`, `received_at` WHERE `contact_id = contactId` ORDER BY `received_at` DESC LIMIT `limit`; reverse to chronological; filter `direction = 'inbound'` → role `'user'`; drop null text bodies. No `WHERE tenant_id` — RLS only.
- [ ] 5.3 **RED** — Add 24h-window integration test to same file: `isWithin24hServiceWindow` returns false when last inbound > 24h; true when ≤ 24h; false when no inbound messages exist (edge case from spec).
- [ ] 5.4 **GREEN** — Create `apps/backend/src/ai/ai-reply.service.ts` stub (or a separate helper) with `isWithin24hServiceWindow(withTenant, tenantId, contactId): Promise<boolean>`: `MAX(received_at) WHERE direction = 'inbound'` for the contact; compare to `NOW() - INTERVAL '24 hours'` using DB server time.

## Phase 6: tenant-ai-config repository (PR 2, TDD)

- [ ] 6.1 **RED** — Write integration test `apps/backend/test/ai/tenant-ai-config.repo.int.test.ts` using `createTestDb()`: `getTenantAiConfig` returns `ok(null)` when no row; `ok(null)` when `enabled = false`; `ok(null)` when `deleted_at IS NOT NULL`; `ok(row)` when one active enabled row; `err(MULTIPLE_CONFIGS)` when two active rows; RLS tenant isolation (tenant B cannot read tenant A's row).
- [ ] 6.2 **GREEN** — Create `apps/backend/src/ai/tenant-ai-config.repository.ts`: `getTenantAiConfig(withTenant, tenantId): Promise<Result<TenantAiConfig | null, { code: 'DB_ERROR' | 'MULTIPLE_CONFIGS' }>>`. Uses `withTenant`; no `WHERE tenant_id`; filters `deleted_at IS NULL` and `enabled = true`; returns `err(MULTIPLE_CONFIGS)` on >1 row.

## Phase 7: System prompt builder (PR 2)

- [ ] 7.1 Create `apps/backend/src/ai/system-prompt.ts`: `buildTiendaGeneralSystemPrompt(config: TenantAiConfig): string` — fills `Docs/specs/ai-agents.md §5` template substituting `business_name`, `vertical`, `tienda_general` intent list; returns `config.systemPromptOverride` verbatim when non-null.
- [ ] 7.2 **Unit test** `apps/backend/test/ai/system-prompt.unit.test.ts`: generated prompt contains `business_name` and all four intents; `system_prompt_override` replaces generated prompt; customer text never appears in system prompt.

## Phase 8: Tool registry (PR 2, TDD)

- [ ] 8.1 **RED** — Write unit test `apps/backend/test/ai/tool-registry.unit.test.ts`: unknown tool → returns `{ error: 'unknown_tool' }` LlmMessage; Zod-invalid input → returns `{ error: 'invalid_input' }` (execute not called); `getBusinessInfo` with config in ctx → returns `ok({ business_name, business_info })`; `getBusinessInfo` with null config → `err(CONFIG_UNAVAILABLE)`; `classifyContact` valid input calls contacts repo `update` with correct patch; `classifyContact` invalid intent rejected by Zod before execute; pino audit entry emitted per call; no DB handle in tool context.
- [ ] 8.2 **GREEN** — Create `apps/backend/src/ai/tool-registry.ts`: `AiTool<I, O>` type; `ToolError` union; `getBusinessInfo` (read from pre-loaded config in ctx, no second DB query); `classifyContact` (Zod enum `ver_catalogo | hacer_pedido | consultar_precio | estado_pedido | otro`, writes via contacts repo `update` using `withTenant`); `executeTool(deps, tenantId, block)` (lookup → Zod parse → run → pino audit → return `LlmMessage`).
- [ ] 8.3 **Integration test** `apps/backend/test/ai/classify-contact.int.test.ts` (Testcontainers): `classifyContact` writes `intent` + `tags` + `intentConfidence` to the contact row; contact of tenant B not visible from tenant A (RLS); contact not found → `err(CONTACT_NOT_FOUND)`.

## Phase 9: runAiReply orchestrator (PR 2, TDD)

- [ ] 9.1 **RED** — Write unit test `apps/backend/test/ai/ai-reply.service.unit.test.ts` using `createFakeLlmAdapter` + in-memory config + history stubs (no DB): AI disabled (`ok(null)`) → skips, pino info logged; window closed → skips, pino info logged; LLM text on first call → `sendWhatsappText` called once; one tool call then text → tool executed once, reply sent; always-tool-call → max 5 then warn log, no reply; tool returns error → error result fed back to LLM, loop continues; LLM error → `err(LLM_FAILED)`, no reply; send error → `err(SEND_FAILED)`, pino error logged; unexpected exception → caught, pino error, no unhandled rejection.
- [ ] 9.2 **GREEN** — Complete `apps/backend/src/ai/ai-reply.service.ts`: `AiReplyInput`, `AiReplyError` union, `runAiReply(deps, input): Promise<Result<{ wamid: string; toolCalls: string[] }, AiReplyError>>` following the design flow (steps 1–10 from design.md §D2); all errors `Result`; never throws to caller; pino audit at each gate (`ai_reply_skipped`, `ai_tool_limit_reached`, `ai_reply_sent`, `ai_reply_failed`).

## Phase 10: handleInboundMessage return shape + webhook trigger (PR 2)

- [ ] 10.1 Extend `handleInboundMessage` success value in `apps/backend/src/webhooks/whatsapp.service.ts`: add `tenantId`, `fromPhoneE164`, `text` fields to the returned `ok({ wamid, contactId, tenantId, fromPhoneE164, text })`. Additive — no HTTP contract change.
- [ ] 10.2 Update `apps/backend/src/webhooks/whatsapp.route.ts`: on the SUCCESS path (after `result.ok`), fire `void runAiReply(deps, { tenantId: result.value.tenantId, contactId: result.value.contactId, fromPhoneE164: result.value.fromPhoneE164, text: result.value.text }).catch((cause) => deps.logger.error({ cause }, '[ai-reply] unhandled rejection'))` BEFORE `return c.text('ok', 200)`. Switch `console.warn` on the error path to `deps.logger.warn`.
- [ ] 10.3 **Verify** existing webhook integration tests still pass with the extended return shape; update any assertion that destructures the `ok` value to include the new fields if needed.

## Phase 11: End-to-end integration test (PR 2)

- [ ] 11.1 Write integration test `apps/backend/test/ai/ai-reply.int.test.ts` (Testcontainers): seed `tenant_ai_config` row + contact + recent inbound message; call `runAiReply` with fake LLM scripted to return text; verify `sendWhatsappText` (fake Meta client) was called with correct phone; verify pino `ai_reply_sent` log; AI disabled scenario → no send; 24h window closed scenario → no send.

## Phase 12: Docs + env example (PR 2)

- [ ] 12.1 Add `ANTHROPIC_API_KEY` and `AI_MODEL` to `apps/backend/.env.example` (or root `.env.example`) with comments: `ANTHROPIC_API_KEY` marked optional when `ENABLE_DEV_ENDPOINTS=true` (fake LLM used); `AI_MODEL` defaults to `claude-haiku-4-5`.
- [ ] 12.2 Run `pnpm --filter @sivihub/whatsapp-hub-backend test` — all tests pass; run `pnpm --filter @sivihub/whatsapp-hub-backend typecheck` — no type errors.

---

## Task summary

| Phase | Tasks | Focus | PR |
|-------|-------|-------|-----|
| 1 | 5 | Migration + schema + MIGRATION_FILES wiring | PR 1 |
| 2 | 2 | Env vars + dev seed | PR 1 |
| 3 | 5 | LlmAdapter interface + real + fake (TDD) | PR 1 |
| 4 | 4 | AppDeps + main.ts + all existing call sites | PR 1 |
| 5 | 4 | getConversationHistory + 24h window (TDD) | PR 2 |
| 6 | 2 | tenant-ai-config repository (TDD) | PR 2 |
| 7 | 2 | System prompt builder | PR 2 |
| 8 | 3 | Tool registry (TDD + integration) | PR 2 |
| 9 | 2 | runAiReply orchestrator (TDD) | PR 2 |
| 10 | 3 | handleInboundMessage extension + webhook trigger | PR 2 |
| 11 | 1 | End-to-end integration test | PR 2 |
| 12 | 2 | Docs + env example + final green gate | PR 2 |
| **Total** | **35** | | **2 PRs** |

---

## Spec coverage

| Spec requirement | Tasks |
|---|---|
| tenant_ai_config schema + RLS + dev seed | 1.1–1.5, 2.1–2.2, 6.1–6.2 |
| LlmAdapter interface (real + fake) | 3.1–3.5 |
| AppDeps.llm + logger; main.ts gating | 4.1–4.3 |
| getConversationHistory (inbound-only, ≤10) | 5.1–5.2 |
| 24h service window enforcement | 5.3–5.4 |
| System prompt construction (tienda_general, override) | 7.1–7.2 |
| Tool registry (getBusinessInfo, classifyContact, allowlist) | 8.1–8.3 |
| runAiReply orchestrator (all gates + loop + error containment) | 9.1–9.2 |
| Ack-fast (fire-and-forget, 200 before AI) | 10.1–10.3 |
| sendWhatsappText reuse + pino logs | 9.2, 11.1 |
| ANTHROPIC_API_KEY optional, AI_MODEL default | 2.1, 4.2, 12.1 |
| No DB handle to LLM | 8.1–8.2 (AiTool ctx shape) |
| No WHERE tenant_id (RLS via withTenant always) | 5.2, 6.2, 8.2 |
