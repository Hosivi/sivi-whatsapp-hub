# Proposal: payment-link-core (Corte 3, slice 1)

## Intent

Corte 3 turns the Hub into a seller that **collects payments**. Today zero payments code exists. This first vertical slice delivers a mock-first, end-to-end **payment link → paid** round-trip: create a payment link, persist a `pending` record, receive the gateway webhook, and mark it `paid`. It is Meta-independent and SUNAT-independent, so it ships and is testable in isolation. It unblocks everything downstream (SUNAT issuance, AI `createPaymentLink` tool, appointment payments).

## Scope

### In Scope
- `PaymentGatewayAdapter` port — `createPaymentLink(input) → Result<PaymentLink, GatewayError>`
- `createFakeCulqiAdapter()` test double (mirrors `createFakeLlmAdapter`: `calls[]`, programmable)
- `payments` schema (Drizzle + migration + RLS `tenant_isolation`) with polymorphic source link
- `tenant_payment_config` schema (Drizzle + migration + RLS) — `configured` flag + non-secret fields
- `createPaymentConfigRepository` + `createPaymentsRepository` (withTenant, Result<T,E>)
- `createPaymentLinkUseCase` — verifies gateway configured, calls adapter, inserts `pending` record
- `POST /webhooks/culqi` — raw body, HMAC-SHA256, tenant resolution via metadata, idempotent `markPaid`
- `payment.paid` `mitt` event emitted post-paid
- Unit + integration tests (full round-trip)

### Out of Scope
- Real Culqi HTTP adapter · Izipay adapter · SUNAT issuance (billing schema, Nubefact, CPE)
- AI `createPaymentLink` tool · worker jobs · WhatsApp post-pay notification
- Yape/Plin manual confirmation · dashboard UI · encrypted credentials / AES keys

## Decisions (resolved)

| Decision | Choice | Rationale |
|---|---|---|
| Gateway first | **Culqi** | PRD §7.2 "principal"; Izipay follows |
| Tenant resolution | Culqi `metadata` (`tenantId`+`paymentId` embedded at link creation), HMAC-first trust, **NO fallback** | Trust metadata only after the signature passes; no cross-tenant lookup/read (gate decision dropped the `external_id` fallback) |
| Post-paid trigger | `mitt` event `payment.paid` (not a direct call) | SUNAT hooks in later without touching the webhook |
| Credentials | **No encryption this slice**; `tenant_payment_config` stores `configured` flag + non-secret fields | Fake adapter needs no secrets; real-credential AES deferred to real-Culqi slice |
| Source link | Polymorphic `source_entity_type TEXT` + `source_entity_id UUID` (nullable) | Free-form sale now, `citas` in Corte 4, no costly remigration |
| Idempotency | Guard `WHERE status='pending'` from day 1 | Culqi retries on non-2xx; no duplicate processing |

## Capabilities

### New Capabilities
- `payment-link`: configure a tenant's payment gateway, create a payment link for a sale, persist its lifecycle (`pending → paid | failed | expired`), and reconcile payment via an idempotent, HMAC-verified gateway webhook that emits `payment.paid`.

### Modified Capabilities
- None.

## Approach

Mirror established patterns exactly. Port/adapter follows `llm-adapter.ts`; fake adapter follows `createFakeLlmAdapter`. Schemas follow `tenant-ai-config.schema.ts` (uuid PK, `tenant_id`, TIMESTAMPTZ, `deleted_at`, RLS `tenant_isolation`). Repositories follow `contacts.repository.ts` (factory + `withTenant` + `Result<T,E>`, no `WHERE tenant_id`). Webhook follows `whatsapp.service.ts` (raw `arrayBuffer()` before parse, `timingSafeEqual`, ack-fast 200). Hub never custodies funds — only generates the link, listens, marks paid. Deliver as 2 chained PRs.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `apps/backend/src/payments/payment-gateway-adapter.ts` | New | Port + types (`PaymentLink`, `GatewayError`) |
| `apps/backend/src/payments/fake-culqi-adapter.ts` | New | Test double |
| `apps/backend/src/db/schema/payments.schema.ts` | New | `payments` pgTable + `mapRowToPayment` |
| `apps/backend/src/db/schema/tenant-payment-config.schema.ts` | New | `tenant_payment_config` pgTable |
| `apps/backend/src/db/migrations/*` | New | 2 tables + RLS `tenant_isolation` policies |
| `apps/backend/src/payments/payment-config.repository.ts` | New | save/find gateway config |
| `apps/backend/src/payments/payments.repository.ts` | New | createRecord, markPaid, findByReference |
| `apps/backend/src/payments/create-payment-link.use-case.ts` | New | Orchestrates config check + adapter + insert |
| `apps/backend/src/webhooks/culqi.service.ts` + route in `main.ts` | New/Modified | HMAC, tenant resolution, idempotent markPaid, emit `payment.paid` |
| `apps/backend/src/events/*` (mitt) | New/Modified | Register `payment.paid` event |
| `apps/backend/src/payments/__tests__/*` | New | Unit + integration |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Culqi metadata passthrough unverified | Med | Encode contract in fake adapter; verify Culqi docs before real adapter; if metadata can be lost, add a fallback in the real-adapter slice with a test |
| Duplicate webhook processing (Culqi retries) | Med | Idempotent `WHERE status='pending'` guard; ack-fast 200 |
| 2-PR budget: PR 2 starts before PR 1 merged | Med | Gatekeeper blocks PR 2 until PR 1 merged |

## Rollback Plan

Pure additive change. Revert the feature commits (code is new, no existing behavior modified) and drop the two new migrations (`payments`, `tenant_payment_config`). No data backfill, no cross-module coupling to unwind.

## Dependencies

- Existing: `withTenant`/RLS (`db/client.ts`), HMAC helper pattern (`whatsapp.service.ts`).
- NEW dependency: `mitt` (not yet in the backend) — this slice adds it + the first `events/event-bus.ts` seam.

## Review Workload Forecast

- Estimated changed lines: **~840**
- 400-line budget risk: **High**
- Chained PRs recommended: **Yes** — PR1 data layer (~350: port + fake + 2 schemas + migrations + 2 repos), PR2 behavior (~490: use case + webhook + `payment.paid` + integration tests)
- Decision needed before apply: **Yes**

## Success Criteria

- [ ] `createPaymentLinkUseCase` returns a link URL only when the tenant gateway is `configured`; otherwise a typed `Result` error.
- [ ] A `payments` row is created with `status='pending'` and the embedded `tenantId`/`paymentId` metadata.
- [ ] `POST /webhooks/culqi` verifies HMAC, resolves tenant from signed metadata only (no fallback; HMAC-valid-but-unknown → 200 no-op), and marks the record `paid` exactly once (idempotent on retry).
- [ ] `payment.paid` is emitted on transition to paid.
- [ ] All queries rely on RLS (`withTenant`), zero `WHERE tenant_id`; domain returns `Result<T,E>`.
- [ ] Full round-trip covered by integration tests against the fake adapter; ships as 2 chained PRs.
