# Spec — ai-tool-registry

> Domain: ai-tool-registry (NEW capability — typed functional-DI tool registry)
> Slice: Corte 2 #1 (ai-reply change, merged PR #7)

---

## Purpose

Define the observable behavior of the `AiTool` registry and its two slice-#1
tools: `getBusinessInfo` (READ) and `classifyContact` (WRITE). This spec
describes WHAT must be true — not how it is implemented.

---

## Requirements

### Requirement: AiTool Interface Contract

Each tool MUST satisfy the `AiTool<TInput, TOutput>` interface:
- `name`: unique string identifier (snake_case)
- `description`: human-readable string for LLM context
- `inputSchema`: Zod schema for the input; the LLM's tool-call arguments MUST be
  validated against this schema before execution
- `execute(input, ctx): Promise<Result<TOutput, ToolError>>`: MUST NOT throw for
  any domain or application error; MUST return `Result<T, E>`

Every tool invocation MUST emit a pino log entry containing `tool_name` and
`args`. Secret values (API keys, tokens, DB handles) MUST NOT appear in any log
entry at any level.

#### Scenario: invalid input is rejected before execute

- GIVEN `classifyContact` receives arguments that fail its Zod input schema
  (e.g. `intent` is missing)
- WHEN the registry executor validates the input
- THEN `execute` is NOT called
- AND the result is `err({ kind: 'INVALID_INPUT', ... })`

#### Scenario: execute is never called with a DB handle

- GIVEN any registered tool is invoked
- WHEN `execute` receives its context argument
- THEN the context MUST NOT contain a raw database connection or query handle
- AND the tool accesses data only via injected repository functions

#### Scenario: pino log entry emitted per tool call

- GIVEN `getBusinessInfo` is invoked
- WHEN `execute` runs (success or error)
- THEN exactly one pino log entry is emitted containing `tool_name = 'getBusinessInfo'`
  and the serialized input args
- AND no secret values appear in the log entry

---

### Requirement: Tool — getBusinessInfo

`getBusinessInfo` MUST:
- Have `name = 'getBusinessInfo'`.
- Accept an empty or minimal input (no required arguments for slice #1).
- Return the tenant's `business_name`, and the full `business_info` JSONB from
  the `tenant_ai_config` row, formatted for direct LLM consumption.
- Use the `TenantAiConfig` object passed via context (already loaded before
  the reply loop starts) — it MUST NOT issue a second DB query.
- Return `ok(businessData)` on success.
- Return `err({ kind: 'CONFIG_UNAVAILABLE' })` if the config object is absent.

#### Scenario: returns business data from loaded config

- GIVEN the tenant's `tenant_ai_config` row has
  `business_name = 'Tienda Demo'` and `business_info = { "horario": "9am-6pm" }`
- WHEN `getBusinessInfo.execute({}, ctx)` is called with that config in ctx
- THEN the result is `ok({ business_name: 'Tienda Demo', business_info: { "horario": "9am-6pm" } })`
  (or an equivalent representation that includes both fields)

#### Scenario: config absent → err CONFIG_UNAVAILABLE

- GIVEN the context carries no `tenantAiConfig` (null or undefined)
- WHEN `getBusinessInfo.execute({}, ctx)` is called
- THEN the result is `err({ kind: 'CONFIG_UNAVAILABLE' })`
- AND no DB query is issued

---

### Requirement: Tool — classifyContact

`classifyContact` MUST:
- Have `name = 'classifyContact'`.
- Accept Zod-validated input with at minimum:
  - `intent`: one of the `tienda_general` intent set
    (`ver_catalogo` | `hacer_pedido` | `consultar_precio` | `estado_pedido`)
  - `tags`: string array (may be empty)
  - `intent_confidence`: optional number in [0, 1]
- Update the contact row via the contacts repository using `withTenant` — no
  `WHERE tenant_id`.
- Write `intent`, `tags`, and (if provided) `intent_confidence` to the contact
  identified by the `contactId` in ctx.
- Return `ok({ contactId, intent, tags })` on success.
- Return `err({ kind: 'CONTACT_NOT_FOUND' })` if the contact does not exist
  under the current tenant.
- Return `err({ kind: 'INVALID_INTENT' })` if the supplied intent is not in the
  vertical's allowed set.

#### Scenario: valid intent+tags updates the contact row

- GIVEN a contact with id `contact_001` exists under tenant A
- WHEN `classifyContact.execute({ intent: 'ver_catalogo', tags: ['nuevo'], intent_confidence: 0.9 }, ctx)` is called
  with `ctx.contactId = 'contact_001'`
- THEN the result is `ok({ contactId: 'contact_001', intent: 'ver_catalogo', tags: ['nuevo'] })`
- AND the contact row in `contacts` has `intent = 'ver_catalogo'`,
  `tags @> ARRAY['nuevo']`, and `intent_confidence = 0.9`
- AND no `WHERE tenant_id` was used — RLS via `withTenant` only

#### Scenario: invalid intent → err INVALID_INTENT (rejected by Zod before execute)

- GIVEN the LLM sends `intent = 'reservar_cita'` (not in `tienda_general` set)
- WHEN the registry executor validates the input
- THEN the result is `err({ kind: 'INVALID_INPUT', ... })`
  (Zod catches the enum mismatch before `execute` is called)

#### Scenario: contact not found → err CONTACT_NOT_FOUND

- GIVEN `ctx.contactId = 'nonexistent_id'` under tenant A
- WHEN `classifyContact.execute({ intent: 'ver_catalogo', tags: [] }, ctx)` is called
- THEN the result is `err({ kind: 'CONTACT_NOT_FOUND' })`
- AND no mutation is persisted

#### Scenario: RLS — contact of tenant B not updated by tenant A

- GIVEN contact `contact_b_001` belongs to tenant B
- AND the registry executor runs under tenant A's context
- WHEN `classifyContact.execute({ intent: 'ver_catalogo', tags: [] }, ctx)` is called
  with `ctx.contactId = 'contact_b_001'`
- THEN the result is `err({ kind: 'CONTACT_NOT_FOUND' })`
  (RLS makes the row invisible — not a permission error returned to the LLM)

---

### Requirement: Tool Allowlist per Vertical

The orchestrator MUST pass ONLY the tools in the vertical's allowlist to
`LlmAdapter.complete(messages, tools)`. For `tienda_general` slice #1, the
allowlist is: `[getBusinessInfo, classifyContact]`. The LLM MUST NOT receive any
tool not in the allowlist.

#### Scenario: LLM receives exactly the vertical allowlist

- GIVEN the vertical is `tienda_general`
- WHEN `LlmAdapter.complete` is called by the orchestrator
- THEN the `tools` array passed contains exactly `getBusinessInfo` and
  `classifyContact` — no other tool

---

### Requirement: LlmAdapter Interface Contract

The system MUST expose an `LlmAdapter` interface with a single method:

```
complete(messages: Message[], tools: AiTool[]): Promise<LlmResponse>
```

where `LlmResponse` is a discriminated union:
- `{ type: 'text'; content: string }` — the LLM produced a final text reply
- `{ type: 'tool_use'; toolName: string; toolInput: unknown; stopReason: string }[]`
  — the LLM requested one or more tool calls

The method MUST NOT throw for LLM API errors; those MUST be surfaced as a
`Result` or an explicit error shape within `LlmResponse`. Only unrecoverable
infrastructure failures may propagate.

`createGeminiAdapter(apiKey, model)` MUST satisfy the interface using the
`@google/genai` SDK.

`createAnthropicAdapter(apiKey, model)` MUST satisfy the interface using the
`@anthropic-ai/sdk` (retained for backwards compatibility).

`createFakeLlmAdapter()` MUST satisfy the interface, make no real API calls,
and expose control methods to program responses for deterministic tests.

#### Scenario: interface satisfied by real and fake implementations

- GIVEN `createGeminiAdapter(apiKey, model)` is called
- WHEN the returned object is typed as `LlmAdapter`
- THEN TypeScript compilation succeeds without type errors

- GIVEN `createFakeLlmAdapter()` is called
- WHEN the returned object is typed as `LlmAdapter`
- THEN TypeScript compilation succeeds without type errors

#### Scenario: fake returns programmed text reply

- GIVEN `createFakeLlmAdapter()` with a programmed text reply `'Tenemos disponible.'`
- WHEN `complete(messages, tools)` is called
- THEN the result is `{ type: 'text', content: 'Tenemos disponible.' }`
- AND no network request is made

#### Scenario: fake returns programmed tool_use call

- GIVEN `createFakeLlmAdapter()` programmed to request `getBusinessInfo`
- WHEN `complete(messages, tools)` is called
- THEN the result includes `{ type: 'tool_use', toolName: 'getBusinessInfo', ... }`
- AND no network request is made

---

## Out of Scope (Non-Requirements for This Slice)

- `ai.invocation_log` table — pino logging only for slice #1.
- Tools for payment, scheduling, or invoicing (Cortes 3/4).
- `escalateToHuman` side effect — the 5-call limit logs and stops only.
- `requires_human_confirmation` flag — no money-moving tools in slice #1.
- Tool versioning or per-tool enable/disable flags.
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
