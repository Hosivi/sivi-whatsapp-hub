# CLAUDE.md — sivi-whatsapp-hub

This file guides Claude Code when working in this repository.

## What this is

**sivi-whatsapp-hub** (the "WhatsApp Hub") is a **standalone, WhatsApp-first SaaS** for Peruvian MYPEs. It turns a business's WhatsApp into an automated AI seller/assistant: answers questions, gives info, schedules appointments, **collects payments via payment links**, and **issues SUNAT e-invoices** — all configurable without code. WhatsApp is the core channel (>90% of Peru's internet users use it as their main app).

This is **one part of the SiviHub ecosystem**, built and run as a **separate project / separate repo**:

```
            SiviHub (umbrella brand)
   ┌──────────────┬──────────────────────┐
SiviHub CRM   WhatsApp Hub            Agent Hub
(the core,    (THIS repo — faces the   (internal CRM
 unifies      END CUSTOMER via          agent, faces the
 data)         WhatsApp)                 business OWNER)
   └────── connected by CONTRACTS ───────┘
```

**The frontier rule (non-negotiable):** the Hub owns its domain (WhatsApp contacts, conversations, messages, templates, broadcasts, intent, payments, appointments, comprobantes). It hands data to the CRM **only through well-defined contracts** (`ContactLead` today; future ones for sales/appointments/comprobantes). The Hub **never reads or writes the CRM's tables directly.** This discipline is what lets the projects unify later without pain.

## Two AIs — do not confuse them

- **This Hub's AI** → talks to the **END CUSTOMER** (sells, schedules, charges). Task-specific, Meta-governed.
- **Agent Hub (separate)** → assists the **business OWNER** inside the CRM. Not built here.

## Stack (inherited from the SiviHub ecosystem — same as the CRM)

- **Monorepo**: Turborepo + pnpm + Biome + lefthook. Node 22, TS 5.5+.
- **Backend**: HonoJS + **functional composition for DI (no container, no awilix, no decorators, no classes for wiring)**. Drizzle ORM, Zod, mitt, croner, pg-boss, pino, jose (JWT).
- **DB**: **Postgres 16 self-hosted** as the only data infrastructure (data + cache + queue + pub/sub). **No Supabase. No Redis.**
- **Web**: Next.js 15 (App Router) + React 19 + shadcn/ui + Radix + Tailwind.
- **Deploy**: Hetzner VPS + Caddy + Docker Compose.

## Hard rules

- **Multi-tenancy = RLS from commit 1.** Every domain table has `tenant_id` + a `tenant_isolation` policy. The tenant middleware runs `SET LOCAL app.current_tenant` per request. **No query may EVER rely on an explicit `WHERE tenant_id`** — that is the footgun RLS prevents.
- **Do NOT custody funds.** Each tenant connects their OWN Culqi/Izipay account; sale money goes straight to them. The Hub only generates the link, listens to the webhook, and issues the comprobante. Monetization = **monthly membership** (no per-transaction fee, no payment split).
- **WhatsApp only via the official Meta Cloud API** — never unofficial APIs (Baileys, etc.). 24h service window; templates for proactive messages; opt-in mandatory.
- **AI is task-specific and governed.** The LLM never writes to the DB or charges on its own — it only invokes registered, audited Tools. General-purpose chatbots are banned by Meta (2026) → WABA suspension risk. Full-auto in conversation; human confirmation on charges.
- **Payments**: never ask for card data in WhatsApp — always an external payment link.
- **E-invoicing (SUNAT)**: determine the CPE type dynamically by tenant regime + receptor; never hardcode. Only persist a comprobante once SUNAT accepts it (CDR).
- **Language**: docs & chat in Spanish (Rioplatense). UI copy in Spanish via i18n. **Code, identifiers, comments, commit messages, PR descriptions in English.**
- **Conventions**: internal packages `@sivihub/<name>`; files/dirs `kebab-case`; classes `PascalCase`; functions/vars `camelCase`; constants `SCREAMING_SNAKE_CASE`. UUID PKs (`gen_random_uuid()`), `TIMESTAMPTZ` always, soft-delete (`deleted_at`).
- **Errors**: never `throw` in domain logic → use `Result<T, E>`. Throw only in infrastructure (Hono `onError` catches it).

## Repo structure

```
apps/
  backend/     → Hono — REST + webhooks (main.ts) + worker (worker.ts)
  web/         → Next.js dashboard (later)
packages/
  contracts/   → @sivihub/contracts — ContactLead + future cross-CRM contracts
turbo.json · pnpm-workspace.yaml · biome.json · lefthook.yml · tsconfig.base.json
Docs/
  prd.md       → product vision (source of truth for scope)
  adr/         → Hub-specific decisions (own numbering, 0001+)
  specs/       → per-module specs
```

## Roadmap (vertical slices, mock-first)

| Corte | What | Meta? |
|---|---|---|
| 0 ✓ | Walking skeleton (`/health` + `ContactLead`) | No |
| 1 | Contacts: import + dedupe by `phone_e164` + CRUD + tags + manual intent | No — start now |
| 2 | Conversation + task-specific AI (24h window) + basic no-code builder | Yes |
| 3 | Sales + payments (Culqi/Izipay) + SUNAT e-invoicing post-payment | Yes |
| 4 | Scheduling/appointments + advanced AI | Yes |
| 5 | Broadcasts (templates + opt-in) + more verticals | Yes |

## Rejected (from the user's "CLAUDE.md v2.0", with reason)

Supabase (→ Postgres self-hosted) · manual `WHERE tenant_id` (→ RLS footgun) · Better-Auth (→ functional DI + jose) · n8n (→ croner + in-binary worker) · AI from day 1 (→ validate core first).

## References

- `Docs/prd.md` — product vision and scope.
- `Docs/specs/` — facturacion-sunat, agenda-citas, ai-agents.
- Ecosystem ADRs (in the SiviHub CRM repo): 0003 (RLS), 0004 (Postgres), 0008 (governed AI), 0009/0015 (slices/mock-first), 0013 (two-processes-one-binary), 0016 (WhatsApp Cloud API), 0017 (functional DI).
