# Spec — fixed-replies

> Domain: fixed-replies (NEW capability — fixed greeting, hours and handoff replies)
> Slice: fixed-replies (SiviHub B2B stage E1, task T11; owner decision D13)

---

## Purpose

Until SiviHub's agent takes over (stage E4), the Hub answers end customers ONLY
with fixed replies — a greeting, the business hours, and a handoff to an advisor —
and never with AI-generated text. This spec defines when each fixed reply is sent,
its text, and the per-tenant settings that override it. It describes WHAT must be
true — not how it is implemented.

---

## Requirements

### Requirement: fixed-replies — When They Run

The fixed replies MUST run only while `AI_REPLY_ENABLED` is off (the default; see
the `ai-reply` spec), only for a newly persisted inbound text (never for a
re-delivered `wamid`; see the `webhooks` spec), and in the background after the
webhook has returned `200`. The LLM MUST NOT be called on this path.

The reply MUST be sent only while the WhatsApp 24 h service window is open (the
contact sent an inbound message in the last 24 h, measured with DB server time).

#### Scenario: switch off → fixed reply, no LLM call

- GIVEN `AI_REPLY_ENABLED` is unset
- AND the tenant's `tenant_ai_config` row has `enabled = true`
- WHEN a contact sends their first text in 24 h
- THEN the LLM is not called
- AND only the fixed greeting is sent

#### Scenario: switch on → no fixed reply

- GIVEN `AI_REPLY_ENABLED = "true"`
- WHEN a new inbound text arrives
- THEN no fixed reply is sent (only the AI path runs)

#### Scenario: re-delivered wamid → no second reply

- GIVEN a message was received and answered with a fixed reply
- WHEN Meta delivers the same `wamid` again
- THEN no second reply is sent

---

### Requirement: fixed-replies — Selection

The text is normalized before matching: trimmed, lower-cased and stripped of
accents. Exactly one reply kind, or none, is selected:

1. `2` as the whole trimmed message, or an advisor keyword → **handoff**.
2. `1` as the whole trimmed message, or an hours keyword → **hours**.
3. Otherwise, if the contact sent no other inbound text in the last 24 h
   (the current message excluded) → **greeting**.
4. Otherwise → no reply. The Hub MUST NOT answer every message.

Keywords match as whole words only:

| Kind | Keywords |
|---|---|
| hours | horario, hora, horas, abren, abierto, atienden, atencion, cierran |
| handoff | asesor, asesora, persona, humano, agente, vendedor, ayuda |

An explicit intent (`1`, `2` or a keyword) wins over the greeting. When both
keyword families match, handoff wins.

#### Scenario: first message → greeting

- GIVEN the contact sent no text in the last 24 h
- WHEN they write "Hola"
- THEN the greeting is sent

#### Scenario: second message within 24 h → no greeting

- GIVEN the contact already wrote in the last 24 h
- WHEN they write "Hola" again
- THEN no reply is sent

#### Scenario: menu option or keyword → hours or handoff

- WHEN the contact writes "1" or "¿A qué HORA abren?"
- THEN the hours reply is sent
- WHEN the contact writes "2" or "Quiero hablar con un asesor"
- THEN the handoff reply is sent

#### Scenario: intent on the first message wins over the greeting

- GIVEN the contact sent no text in the last 24 h
- WHEN they write "Hola, ¿a qué hora abren?"
- THEN the hours reply is sent instead of the greeting

#### Scenario: anything else → silence

- GIVEN the contact already wrote in the last 24 h
- WHEN they write "gracias"
- THEN no reply is sent

---

### Requirement: fixed-replies — Texts

Customer-facing texts are neutral Peruvian Spanish with tuteo. The defaults live in
code; `{negocio}` is the business name and `{horario}` the hours text:

| Kind | Default text |
|---|---|
| greeting | «¡Hola! Gracias por escribir a {negocio}. Responde 1 para ver nuestro horario o 2 para hablar con un asesor.» |
| greeting (no business name) | «¡Hola! Gracias por escribirnos. Responde 1 para ver nuestro horario o 2 para hablar con un asesor.» |
| hours | «Nuestro horario de atención es: {horario}.» |
| handoff | «Listo, un asesor te responderá por este chat en cuanto esté disponible.» |

- Without an hours text, the hours reply MUST fall back to the handoff reply.
- A per-tenant override text MAY use the same placeholders. An override that needs
  a value the tenant has not set MUST NOT be sent half-filled: the default applies.
- Blank values count as not set.

#### Scenario: override texts are used

- GIVEN the tenant's settings have `business_name = 'Bodega Rosa'` and
  `greeting_text = '¡Bienvenido a {negocio}! Escribe 1 o 2.'`
- WHEN a contact sends their first text in 24 h
- THEN the greeting sent is «¡Bienvenido a Bodega Rosa! Escribe 1 o 2.»

#### Scenario: no hours text → handoff instead of hours

- GIVEN the tenant has no hours text
- WHEN the contact writes "1"
- THEN the handoff reply is sent

---

### Requirement: fixed-replies — Delivery and Audit

Every fixed reply MUST be sent through the same outbound path as any other text
(`sendWhatsappText`), so it is stored as an outbound message of the conversation.

Each run MUST emit exactly one pino log line:

| Outcome | Log message |
|---|---|
| sent | `fixed_reply_sent kind=<greeting\|hours\|handoff>` |
| skipped | `fixed_reply_skipped reason=<DISABLED\|WINDOW_CLOSED\|NO_MATCH>` |
| failed | `fixed_reply_failed reason=<SEND_FAILED\|DB_ERROR>` |

The service MUST NOT throw: every outcome is a `Result`, and unexpected exceptions
are caught and logged as `fixed_reply_failed reason=DB_ERROR`.

#### Scenario: greeting stored as an outbound message

- WHEN the greeting is sent
- THEN a `whatsapp_messages` row with `direction = 'outbound'` and the greeting
  text exists for the tenant

#### Scenario: Meta send error

- GIVEN Meta rejects the send
- WHEN a fixed reply is due
- THEN `fixed_reply_failed reason=SEND_FAILED` is logged
- AND no outbound message is stored

---

### Requirement: tenant_reply_settings — Schema

Migration `0010_fixed_replies.sql` MUST create a `tenant_reply_settings` table:

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID | PK default `gen_random_uuid()` |
| `tenant_id` | UUID | NOT NULL |
| `business_name` | TEXT | NULLABLE — value of `{negocio}` |
| `greeting_text` | TEXT | NULLABLE — greeting override |
| `hours_text` | TEXT | NULLABLE — value of `{horario}` |
| `handoff_text` | TEXT | NULLABLE — handoff override |
| `enabled` | BOOLEAN | NOT NULL default `true` |
| `created_at` | TIMESTAMPTZ | NOT NULL default `now()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL default `now()` |
| `deleted_at` | TIMESTAMPTZ | NULLABLE (soft-delete) |

At most one live row per tenant (partial unique index on `tenant_id` WHERE
`deleted_at IS NULL`).

- No live row → the default texts apply.
- A live row with `enabled = false` → no fixed replies for that tenant.

#### Scenario: disabled settings silence the tenant

- GIVEN the tenant's live row has `enabled = false`
- WHEN a contact writes "Hola" or "2"
- THEN no reply is sent
- AND `fixed_reply_skipped reason=DISABLED` is logged

---

### Requirement: tenant_reply_settings — RLS Tenant Isolation

The table MUST have RLS enabled and forced, with a `tenant_isolation` policy for
`app_rls` that restricts every operation to rows where `tenant_id` matches
`app.current_tenant` (USING and WITH CHECK). Reads go through `withTenant`; no query
may use `WHERE tenant_id`.

#### Scenario: tenant B cannot read tenant A settings

- GIVEN a `tenant_reply_settings` row exists for tenant A
- WHEN the table is read under tenant B's context
- THEN zero rows are returned

#### Scenario: insert for another tenant is rejected

- GIVEN the `app_rls` role is active with tenant A's context
- WHEN an INSERT with `tenant_id = <tenant-B-uuid>` is attempted
- THEN the insert fails the WITH CHECK clause and nothing is stored

---

### Requirement: tenant_reply_settings — Dev Seed

The dev seed MUST insert exactly one live row for the dev tenant with its business
name and the hours text already present in the dev `business_info.hours`, keeping
the default greeting and handoff texts. The seed MUST be idempotent and MUST NOT
rewrite an existing row.

#### Scenario: dev seed produces one settings row

- GIVEN the dev seed has been run twice
- WHEN `tenant_reply_settings` is queried for the dev tenant
- THEN exactly one live row exists with the dev business name, the dev hours text
  and `enabled = true`

---

## Out of Scope (Non-Requirements for This Slice)

- An API or UI to edit the texts (E1 edits them through SQL or the seed only).
- A structured weekly schedule and out-of-hours replies.
- Going silent or tagging the contact after a handoff.
- WhatsApp templates for messages outside the 24 h window.
- `WHERE tenant_id` in any query — RLS via `withTenant` only, always.
