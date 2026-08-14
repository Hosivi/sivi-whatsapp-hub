# Proposal: ai-reply — Governed AI auto-reply + auto-classify (Corte 2 slice #1)

## Intent

WhatsApp messages from store customers arrive (inbound path works end-to-end) but nobody answers automatically. Today every "¿cuánto cuesta?" needs a human. This change ships the FIRST governed AI loop: when a `tienda_general` customer writes, the AI answers their store question (products, prices, hours, how to buy) using tenant-configured business info, AND classifies the contact (`intent` + `tags`). It proves the full governed integration (LLM → tool registry → WhatsApp send) on the cheapest, lowest-risk vertical before any money-moving Tools exist (Cortes 3/4). Reference spec: `Docs/specs/ai-agents.md` — this slice implements a strict subset of it.

## Scope

### In Scope
- Async **fire-and-forget** AI reply triggered AFTER the webhook acks 200 (ack-fast preserved).
- Governed loop: load tenant AI config → check enabled → enforce 24h SERVICE window → fetch ~10 recent messages → build `tienda_general` system prompt → `LlmAdapter.complete(messages, tools)` → execute tool calls (max 5/turn) → send reply via existing `sendWhatsappText`. All errors caught + pino-logged (no unhandled rejection).
- `LlmAdapter` injectable interface (mirrors `MetaClient`): `createAnthropicAdapter(apiKey, model)` (real, `@anthropic-ai/sdk`) + `createFakeLlmAdapter()` (deterministic, tests). Injected via `AppDeps.llm`. LLM gets NO DB handle.
- Tool registry (functional DI, typed `AiTool` objects): `getBusinessInfo` (READ tenant info) + `classifyContact` (WRITE `intent`+`tags`+`intent_confidence` on contact via Corte-1 columns). Each tool pino-audited (name+args, token-safe).
- New migration `tenant_ai_config` (`vertical`, `business_name`, `business_info` JSONB, `enabled`, `system_prompt_override?`; RLS `tenant_isolation` + grant `app_rls`). Dev seed inserts a `tienda_general` row.
- New env: `ANTHROPIC_API_KEY` (required), `AI_MODEL` (default `claude-haiku-4-5`).

### Out of Scope (non-goals — stated explicitly)
- Money/scheduling/invoicing Tools (`createPaymentLink`, `scheduleAppointment`, `checkStock`, `confirmOrder`) — Cortes 3/4.
- `ai.invocation_log` DB table — pino logging only this slice.
- Worker / pg-boss / queue / outbox — fire-and-forget only (retry-safe loop is slice #2).
- Approved templates when 24h window closed (silent skip), 72h CTWA window, MCP protocol, RAG, no-code config dashboard, per-contact opt-in flag, per-contact rate limiting.
- `escalateToHuman` side effect — log only (no `needs_human` status, no inbox notify yet).
- Other 7 verticals — only `tienda_general`.

## Decisions (SETTLED — do not reopen)

| Decision | Choice | Rationale |
|---|---|---|
| Pilot vertical | `tienda_general` | Store FAQ is highest-volume, lowest-risk; no clinical/financial sensitivity. |
| Scope shape | RESPOND + AUTO-CLASSIFY | Answers customer AND sets `intent`/`tags` on contact — reuses Corte-1 columns, no new write surface. |
| Opt-in / consent | Customer writes first = 24h window = consent | Meta SERVICE window IS consent; no per-contact flag needed in slice #1. |
| Model | `claude-haiku-4-5` (env `AI_MODEL`) | Cheap/fast; store FAQ + classification need no frontier model. |
| Delivery approach | Fire-and-forget in-process | Zero new infra; reuses MetaClient + sendWhatsappText; proves loop fast. Retry-safe queue is a later slice. |
| LLM isolation | LLM never gets DB; returns text/tool_use only | ADR-0008 governance; app executes audited Tools. |

## Capabilities

> Contract for sdd-spec. Researched `Docs/specs/ai-agents.md` (production spec) + worktree `openspec/specs/` (none exists yet).

### New Capabilities
- `ai-reply`: governed async reply loop — 24h window check, conversation context, system-prompt build, `LlmAdapter` contract, tool-call orchestration (max 5/turn), reply send, full error containment.
- `ai-tool-registry`: functional-DI typed `AiTool` registry with `getBusinessInfo` (read) + `classifyContact` (governed write to contact intent/tags), pino audit per call.
- `tenant-ai-config`: per-tenant AI config table (vertical, business_name, business_info JSONB, enabled, system_prompt_override) with RLS + dev seed.

### Modified Capabilities
- None at spec level. (Webhook trigger is an additive fire-and-forget call; `whatsapp-messages` gains a `getConversationHistory` read helper — implementation detail, no behavior contract change.)

## Approach

Reuse the established functional-DI seam. Add `apps/backend/src/ai/`: `llm-adapter.ts` (interface + real + fake), `tool-registry.ts` (typed tools + executor), `ai-reply.service.ts` (`runAiReply(deps, ...)` orchestrator), `tenant-ai-config.repository.ts`. Wire `llm` into `AppDeps` in `app.ts` and instantiate in `main.ts` like `MetaClient`. The webhook route, after `handleInboundMessage` returns ok, fires `runAiReply(...).catch(logErr)` (no await). Domain returns `Result<T,E>`; only infra throws. System prompt uses the spec §5 base scoped to `tienda_general`; customer text stays in the `user` role (prompt-injection mitigation). Tool allowlist is the registry — LLM cannot call anything unregistered.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/backend/src/ai/` | New | LlmAdapter, tool-registry, ai-reply.service, tenant-ai-config repo |
| `apps/backend/src/webhooks/whatsapp.route.ts` | Modified | Fire-and-forget `runAiReply` after ack |
| `apps/backend/src/app.ts` | Modified | `AppDeps.llm` added |
| `apps/backend/src/main.ts` | Modified | Instantiate Anthropic adapter |
| `apps/backend/src/config/env.ts` | Modified | `ANTHROPIC_API_KEY`, `AI_MODEL` |
| `apps/backend/src/whatsapp-messages/whatsapp-messages.repository.ts` | Modified | `getConversationHistory(contactId, limit)` |
| DB migrations + dev seed | New | `tenant_ai_config` table + `tienda_general` seed row |
| `apps/backend/package.json` | Modified | Add `@anthropic-ai/sdk` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Unhandled promise rejection crashes process | Med | Top-level `.catch` → pino; never await in route |
| LLM drifts to general chat → WABA suspension | Med | Tight scoped prompt + out-of-scope menu (spec §4) + tool allowlist |
| Fire-and-forget loses reply on crash | Med | Accepted for dev/pilot; queue is slice #2 (documented) |
| Duplicate replies on concurrent inbound | Low | Low at MYPE scale; per-contact debounce deferred |
| Prompt injection via customer text | Med | Customer text in `user` role only, never in system prompt |

## Rollback Plan

Feature is additive and gated. To disable: set `tenant_ai_config.enabled = false` (instant, no deploy) or unset `ANTHROPIC_API_KEY` (loop skips). To revert fully: drop the fire-and-forget call in `whatsapp.route.ts` and `git revert` the branch; the `tenant_ai_config` migration is forward-only but inert when unused. Inbound/outbound paths are untouched.

## Dependencies

- `@anthropic-ai/sdk` (new, `pnpm add`).
- Corte-1 contact columns (`tags TEXT[]`, `intent TEXT`, `intent_confidence NUMERIC`) — present.
- Existing `MetaClient` + `sendWhatsappText` + RLS tenant middleware — present.

## Size / Delivery Note

**MEDIUM slice.** Estimate ~350–450 changed lines (new `ai/` dir + migration + seed + env + wiring + tests). May approach/exceed the 400-line review budget once fake-adapter tests land. Flag for sdd-tasks: forecast budget and, if High, recommend a 2-PR split — (PR1) `tenant_ai_config` migration + seed + `LlmAdapter` interface + fakes + env wiring; (PR2) tool registry + `runAiReply` orchestrator + webhook trigger + integration tests.

## Success Criteria

- [ ] A `tienda_general` customer message inside the 24h window receives an AI reply via WhatsApp using seeded business info.
- [ ] The same turn sets `intent` + `tags` (+ `intent_confidence`) on the contact via `classifyContact`.
- [ ] Inbound webhook still returns 200 immediately (ack-fast unaffected); AI runs after.
- [ ] AI is skipped (logged) when `enabled = false` or last inbound > 24h.
- [ ] LLM never receives a DB handle; only registered tools execute; each tool call is pino-audited.
- [ ] All errors contained — no unhandled rejection; fake `LlmAdapter` makes the loop deterministically testable.
