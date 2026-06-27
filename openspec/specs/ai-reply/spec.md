# Spec — ai-reply

> Domain: ai-reply (NEW capability — governed async AI reply loop)
> Slice: Corte 2 #1 (ai-reply change, merged PR #7)

---

## Purpose

Define the observable behavior of the governed AI reply loop that fires after the
inbound WhatsApp webhook returns 200. This spec describes WHAT must be true —
not how it is implemented. Implementation details (file paths, function names)
are design-phase concerns.

---

## Requirements

### Requirement: ai-reply — Ack-Fast (Non-Blocking)

The AI pipeline MUST NOT block or change the inbound webhook response. The
webhook route MUST return `200 OK` to Meta immediately after persisting the
inbound message. The `runAiReply` call MUST be fire-and-forget — it is invoked
AFTER the response is sent and MUST NOT be awaited by the route handler.

#### Scenario: webhook returns 200 before AI pipeline starts

- GIVEN a valid inbound WhatsApp webhook payload
- WHEN the webhook handler processes the request
- THEN the HTTP response is sent with status `200` before any LLM API call is
  made
- AND a subsequent delay or error in the AI pipeline does NOT affect the already-
  sent webhook response

#### Scenario: AI pipeline error does not propagate to webhook

- GIVEN the LLM adapter throws an unexpected error
- WHEN the fire-and-forget call catches it
- THEN the error is logged via pino at `error` level
- AND no unhandled promise rejection is raised at the process level
- AND the webhook response (already sent) is unaffected

---

### Requirement: ai-reply — Tenant AI Config Gate

After being triggered, the loop MUST call `getAiConfig` to load the tenant's
`tenant_ai_config` row.

- If `getAiConfig` returns `ok(null)` (no row, `enabled = false`, or
  soft-deleted), the loop MUST silently stop. No reply is sent. A pino `info`
  log MUST be emitted with `{ event: 'ai_reply_skipped', reason: 'disabled' }`.
- If `getAiConfig` returns an error, the loop MUST stop and log the error at
  `error` level. No reply is sent.
- Only when `getAiConfig` returns `ok(config)` with a non-null config does the
  loop proceed.

#### Scenario: AI disabled → silent skip, no reply

- GIVEN the tenant's `tenant_ai_config` row has `enabled = false`
- WHEN a new inbound message triggers the AI loop
- THEN no WhatsApp reply is sent
- AND a pino info log is emitted with `event: 'ai_reply_skipped'` and
  `reason: 'disabled'` (or `reason: 'no_config'`)

#### Scenario: no config row → silent skip

- GIVEN the tenant has no row in `tenant_ai_config`
- WHEN a new inbound message triggers the AI loop
- THEN no WhatsApp reply is sent
- AND a pino info log indicates the skip

---

### Requirement: ai-reply — 24h Service Window Enforcement

Before calling the LLM, the loop MUST check whether the contact is within the
24-hour service window. The window is determined by the MAX(`received_at`) of the
contact's INBOUND messages (`direction = 'inbound'`).

- If that MAX timestamp is MORE than 24 hours before `now()`, the window is
  CLOSED. The loop MUST silently stop. No free-form reply is sent. No template
  is sent in slice #1. A pino `info` log MUST be emitted with
  `{ event: 'ai_reply_skipped', reason: 'window_closed' }`.
- If the window is open (last inbound ≤ 24h ago), the loop proceeds.
- The timestamp comparison MUST use the database server time (UTC), not the
  application process clock.

#### Scenario: last inbound > 24h ago → window closed, no reply

- GIVEN the contact's last inbound message has `received_at = now() - 25h`
- WHEN the AI loop evaluates the service window
- THEN no reply is sent
- AND a pino info log is emitted with `event: 'ai_reply_skipped'` and
  `reason: 'window_closed'`

#### Scenario: last inbound ≤ 24h ago → window open, loop continues

- GIVEN the contact's last inbound message has `received_at = now() - 2h`
- WHEN the AI loop evaluates the service window
- THEN the loop proceeds to fetch conversation history

#### Scenario: no prior inbound messages (edge case)

- GIVEN the contact has no inbound messages in `whatsapp_messages`
- WHEN the AI loop evaluates the service window
- THEN the loop treats the window as closed (no prior consent signal)
- AND no reply is sent

---

### Requirement: ai-reply — Conversation Context Fetch

The loop MUST fetch the most recent messages for the contact to provide context
to the LLM. The fetch MUST:
- Return at most ~10 messages (exact limit configurable at implementation;
  default 10).
- Include only messages for the current contact scoped via `withTenant` (RLS).
- Map INBOUND messages to the `user` role in the LLM message array.
- EXCLUDE outbound messages from the LLM message array — customer text in `user`
  role only (prompt-injection safety; the LLM MUST NOT see prior AI output as
  injected context in this slice).
- Use `withTenant` — no `WHERE tenant_id` in the query.

#### Scenario: only inbound messages appear in LLM context

- GIVEN contact has 3 inbound and 2 outbound messages in `whatsapp_messages`
- WHEN the loop fetches conversation context
- THEN the `messages` array passed to `LlmAdapter.complete` contains at most 3
  entries, all with role `user`, none with role `assistant`

#### Scenario: context capped at ~10 messages

- GIVEN contact has 15 inbound messages
- WHEN the loop fetches conversation context
- THEN the `messages` array contains at most 10 entries (the most recent 10)

---

### Requirement: ai-reply — System Prompt Construction

The loop MUST build the `tienda_general` system prompt using the template defined
in `Docs/specs/ai-agents.md §5` with the following substitutions from the loaded
`tenant_ai_config`:
- `{nombre_negocio}` → `business_name`
- `{tipo_vertical}` → `vertical`
- `{lista_intenciones_del_vertical}` → the `tienda_general` intent set
  (`ver_catalogo`, `hacer_pedido`, `consultar_precio`, `estado_pedido`)

If `system_prompt_override` is non-null in the config row, that value MUST be
used as the system prompt instead of the generated one.

The system prompt MUST NOT be included in any message returned to the WhatsApp
customer.

#### Scenario: system prompt includes business name and intent list

- GIVEN `tenant_ai_config` has `business_name = 'Tienda Demo'` and
  `vertical = 'tienda_general'` and `system_prompt_override = null`
- WHEN the system prompt is constructed
- THEN the resulting prompt contains `'Tienda Demo'`
- AND it contains all four `tienda_general` intents
- AND it does NOT appear in the WhatsApp reply sent to the customer

#### Scenario: system_prompt_override replaces generated prompt

- GIVEN `tenant_ai_config` has `system_prompt_override = 'Custom prompt.'`
- WHEN the system prompt is constructed
- THEN `'Custom prompt.'` is used as the system prompt verbatim
- AND the generated template is NOT used

---

### Requirement: ai-reply — Tool-Call Orchestration (max 5 per turn)

After calling `LlmAdapter.complete(messages, tools)`, the loop MUST:
1. If the response is `{ type: 'text' }`, send the reply immediately (go to
   "Send Reply" requirement).
2. If the response requests tool calls, execute each tool via the registry
   executor, collect the results, and feed them back to the LLM in the next
   `complete` call.
3. Repeat steps 1–2 until a text response is obtained OR the tool-call count
   reaches 5 for the current turn.
4. If the limit of 5 tool calls is reached without a final text reply:
   - The loop MUST stop.
   - A pino `warn` log MUST be emitted with
     `{ event: 'ai_tool_limit_reached', tool_call_count: 5 }`.
   - NO reply is sent to the customer.
   - The `escalateToHuman` tool MUST NOT be automatically invoked in slice #1.

#### Scenario: LLM text on first call → reply sent immediately

- GIVEN `createFakeLlmAdapter()` programmed to return a text reply on the first
  call
- WHEN the loop calls `complete` once
- THEN no tool is executed
- AND `sendWhatsappText` is called once with the LLM's text

#### Scenario: one tool call then text reply → tool executed, reply sent

- GIVEN `createFakeLlmAdapter()` programmed to request `getBusinessInfo` on the
  first call and return text `'Aquí está la info.'` on the second
- WHEN the loop runs
- THEN `getBusinessInfo.execute` is called once
- AND `sendWhatsappText` is called once with `'Aquí está la info.'`
- AND total LLM calls = 2

#### Scenario: 5 tool calls reached → stop, warn log, no reply sent

- GIVEN `createFakeLlmAdapter()` programmed to always request a tool call
  (never a text response)
- WHEN the loop executes
- THEN tools are executed a maximum of 5 times
- AND `sendWhatsappText` is NOT called
- AND a pino warn entry is emitted with `event: 'ai_tool_limit_reached'`

#### Scenario: tool returns error → result fed back to LLM, loop continues

- GIVEN `classifyContact.execute` returns `err({ kind: 'CONTACT_NOT_FOUND' })`
- WHEN the tool result is collected
- THEN the error result is serialized and included in the next `complete` call
  as a tool result message
- AND the loop does NOT stop or throw because of the tool error

---

### Requirement: ai-reply — Send Reply via sendWhatsappText

When the loop obtains a final text reply from the LLM, it MUST call the existing
`sendWhatsappText` function (the same one used by `POST /whatsapp-send`). The
call MUST:
- Use the tenant's active `whatsapp_account.phone_number_id` and `access_token`.
- Target the inbound message's sender phone (`from_phone_e164`).
- Send the LLM's final text content as the message body.
- On success: emit a pino `info` log with `{ event: 'ai_reply_sent', wamid }`.
- On failure (`WINDOW_CLOSED`, `META_API_ERROR`, `NETWORK_ERROR`, etc.): log the
  error at `error` level with `{ event: 'ai_reply_failed', reason }`. No retry.
  No exception propagates.

#### Scenario: successful send → pino info with wamid

- GIVEN the LLM returns text `'Tenemos stock disponible.'`
- AND `sendWhatsappText` returns `ok({ wamid: 'wamid_ai_001' })`
- WHEN the loop calls `sendWhatsappText`
- THEN a pino info entry is emitted with `event: 'ai_reply_sent'` and
  `wamid = 'wamid_ai_001'`

#### Scenario: Meta window closed → error logged, no retry, no throw

- GIVEN `sendWhatsappText` returns `err({ kind: 'WINDOW_CLOSED' })`
- WHEN the loop processes the error
- THEN a pino error entry is emitted with `event: 'ai_reply_failed'` and
  `reason: 'WINDOW_CLOSED'`
- AND no exception propagates to the process level
- AND no retry is attempted

---

### Requirement: ai-reply — LLM Isolation (No DB Handle)

The LLM MUST NOT receive a database connection, query handle, or credentials at
any point. The `LlmAdapter.complete` method receives only `messages` and `tools`.
Tool context objects MUST be constructed from pre-loaded application data (config
row, contact record) — not from a DB handle.

#### Scenario: LlmAdapter.complete never receives a DB handle

- GIVEN any invocation of the AI reply loop
- WHEN `LlmAdapter.complete(messages, tools)` is called
- THEN the `messages` argument contains only text/role entries
- AND the `tools` argument contains only `AiTool` descriptors (name, description,
  inputSchema)
- AND no database connection object appears in either argument

---

### Requirement: ai-reply — Error Containment

ALL errors in the AI pipeline MUST be caught and logged via pino. No unhandled
promise rejection may propagate from the fire-and-forget call to the process
event loop.

#### Scenario: unexpected exception is caught at the top level

- GIVEN the AI loop encounters an unexpected thrown exception (e.g. OOM in
  JSON serialization)
- WHEN the top-level catch handler runs
- THEN the error is logged at `error` level via pino
- AND `process.on('unhandledRejection')` is NOT triggered

---

### Requirement: ai-reply — Environment Variables

Two environment variables control the AI pipeline:
- `GEMINI_API_KEY` (required): the key passed to `createGeminiAdapter`.
  If absent, the Gemini adapter MUST NOT be instantiated and the loop MUST be
  effectively disabled (treated as no config).
- `AI_MODEL` (optional): the model string passed to `createGeminiAdapter`.
  Default MUST be `gemini-2.5-flash` if the variable is absent.

#### Scenario: AI_MODEL absent → default gemini-2.5-flash

- GIVEN `AI_MODEL` is not set in the environment
- WHEN the Gemini adapter is instantiated
- THEN the adapter uses model `gemini-2.5-flash`

#### Scenario: AI_MODEL set → that model is used

- GIVEN `AI_MODEL=gemini-1.5-pro` is set
- WHEN the Gemini adapter is instantiated
- THEN the adapter uses model `gemini-1.5-pro`

---

## Out of Scope (Non-Requirements for This Slice)

- Approved template messages when the 24h window is closed (silent skip only).
- 72h Click-to-WhatsApp Ad window.
- Worker / pg-boss queue for retry-safe delivery.
- Per-contact opt-in flag beyond "customer writes first".
- Per-contact rate limiting or duplicate-reply debounce.
- `escalateToHuman` side effect on tool-call limit (log + stop only).
- `ai.invocation_log` table (pino audit only).
- Money-moving, scheduling, or invoicing tools.
- Other verticals beyond `tienda_general`.
- MCP server, RAG, no-code dashboard.
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
