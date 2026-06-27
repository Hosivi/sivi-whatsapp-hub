# Design: payment-link-core (Corte 3, slice 1)

## Technical Approach

Mock-first vertical slice mirroring established patterns 1:1. Port/adapter follows `llm-adapter.ts`; schemas follow `tenant-ai-config.schema.ts`; repos follow `contacts.repository.ts` (`withTenant` + `Result`, no `WHERE tenant_id`); webhook follows `whatsapp.service.ts` (raw `arrayBuffer()` → HMAC `timingSafeEqual` → ack-fast 200). Hub never custodies funds. Introduces the first `mitt` event bus seam. Ships as 2 chained PRs: **PR1 data layer**, **PR2 behavior**.

## Architecture Decisions

### Decision: Webhook tenant resolution under RLS (load-bearing)
RLS needs a tenant *before* `withTenant`, but the Culqi POST is un-tenanted. **Choice**: order is (1) read raw body, (2) HMAC-SHA256 verify against a **global** `CULQI_WEBHOOK_SECRET` (mirrors `WHATSAPP_APP_SECRET`) — invalid/missing HMAC → HTTP 400, stop; (3) parse JSON, (4) extract `tenantId`+`paymentId` from `metadata`. Because HMAC covers the whole body, the embedded `tenantId` is trusted once the signature passes — no pre-tenant DB read. (5) if `metadata.tenantId` is absent or unknown → log + return HTTP 200 no-op (no state change, no `resolvePaymentTenant`). (6) `withTenant(tenantId, markPaid)`.
**No `external_id` fallback**: cross-tenant lookup via `resolvePaymentTenant` is dropped. No `app_webhook` role, no `payment_webhook_read USING(true)` policy, no column grant on `(external_id, tenant_id)` to `app_webhook`. RLS on `payments` and `tenant_payment_config` uses ONLY the standard `tenant_isolation` policy + `app_rls` grants (mirrors existing tables).
**Alternatives**: per-tenant webhook secret (rejected — needs a pre-tenant lookup + encrypted creds, out of scope); manual `WHERE tenant_id` (rejected — RLS footgun); `external_id` fallback (rejected — requires cross-tenant read, removed by gate decision).
**Rationale**: HMAC-first trust removes the bootstrap read; secret stays global since no encrypted creds this slice.

> **Gate notes (mock-first decisions — do NOT change behavior):**
> - `mitt` is a NEW backend dependency; MUST be installed via `pnpm --filter @sivihub/whatsapp-hub-backend add mitt` before any code that imports it.
> - `payment.paid` emit MUST be gated on `markPaid` RETURNING `rowCount > 0`; no row updated → no emit (duplicate-webhook guard).
> - HTTP response contract: bad HMAC → 400; HMAC-valid-but-unknown-tenant → 200 no-op; already-paid (idempotent) → 200 no-op. These are DISTINCT paths.
> - `CULQI_WEBHOOK_SECRET` is global in this slice (mock-first). Revisit per-tenant secret when encrypted credentials ship (real-Culqi slice). Do NOT implement per-tenant secrets now.

### Decision: post-paid trigger via `mitt`
**Choice**: emit `payment.paid` on `pending→paid` transition through a new typed `EventBus`. **Alternatives**: direct SUNAT call (rejected — couples webhook to billing). **Rationale**: SUNAT/notify hook in Corte 3 slice 2 without touching the webhook.

### Decision: idempotency via status guard
**Choice**: `markPaid` does `UPDATE ... SET status='paid' WHERE id=? AND status='pending' RETURNING *`; 0 rows → already processed → ok (no re-emit). **Rationale**: Culqi retries on non-2xx; matches `ON CONFLICT DO NOTHING` spirit used for messages.

## Data Flow

    createPaymentLinkUseCase ─→ adapter.createPaymentLink ─→ paymentsRepo.createRecord(pending)
                                                                   │
    Culqi ──POST /webhooks/culqi──→ verify HMAC ─→ parse metadata ─→ withTenant(tenantId)
                                                                   │
                                          markPaid (WHERE status='pending') ─→ events.emit('payment.paid')
                                                                   │
                                                          (ack-fast 200 always)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `payments/payment-gateway-adapter.ts` | Create | Port + `PaymentLink`/`CreatePaymentLinkInput`/`GatewayError` |
| `payments/fake-culqi-adapter.ts` | Create | Test double: `calls[]` + `queueResponse()` |
| `db/schema/payments.schema.ts` | Create | `payments` pgTable + `mapRowToPayment` |
| `db/schema/tenant-payment-config.schema.ts` | Create | `tenant_payment_config` pgTable |
| `drizzle/0005_payments.sql` | Create | 2 tables + RLS + grants (next migration #) |
| `payments/payment-config.repository.ts` | Create | `save`, `find` |
| `payments/payments.repository.ts` | Create | `createRecord`, `markPaid`, `findByReference`, `findById` |
| `payments/create-payment-link.use-case.ts` | Create | config check → adapter → insert pending |
| `events/event-bus.ts` | Create | `mitt` typed bus + `payment.paid` payload |
| `webhooks/culqi.service.ts` | Create | HMAC + resolve + idempotent markPaid + emit |
| `webhooks/culqi.route.ts` | Create | raw body, ack-fast 200 |
| `db/client.ts` | No change | `resolvePaymentTenant` fallback dropped (gate decision) |
| `app.ts` / `main.ts` | Modify | wire `culqi` adapter + `events` into `AppDeps`, dev/fake gate |
| `config/env.ts` | Modify | `CULQI_WEBHOOK_SECRET` |

PR1 = port + fake + 2 schemas + migration + 2 repos. PR2 = use case + event bus + webhook + wiring + integration tests.

## Interfaces / Contracts

```ts
export type CreatePaymentLinkInput = {
  readonly tenantId: string; readonly paymentId: string;   // embedded in metadata
  readonly amount: number; readonly currency: 'PEN' | 'USD';
  readonly description: string;
};
export type PaymentLink = { readonly url: string; readonly externalId: string; readonly raw: unknown };
export type GatewayError =
  | { readonly code: 'GATEWAY_API_ERROR'; readonly status?: number; readonly detail?: string }
  | { readonly code: 'GATEWAY_NETWORK_ERROR'; readonly cause?: unknown };
export type PaymentGatewayAdapter = {
  createPaymentLink(input: CreatePaymentLinkInput): Promise<Result<PaymentLink, GatewayError>>;
};
// createFakeCulqiAdapter(script?) → adapter & { calls: CreatePaymentLinkInput[]; queueResponse(r) }

// EventBus
export type AppEvents = { 'payment.paid': { tenantId: string; paymentId: string; externalId: string; amount: number; currency: string } };
export type EventBus = { emit<K extends keyof AppEvents>(k: K, p: AppEvents[K]): void; on<K extends keyof AppEvents>(k: K, h: (p: AppEvents[K]) => void): void };
```

`payments` columns: `id uuid PK`, `tenant_id uuid`, `amount integer` (minor units), `currency text`, `status text` (`pending|paid|failed|expired`), `external_id text` (unique), `reference text`, `source_entity_type text NULL`, `source_entity_id uuid NULL`, `metadata jsonb`, `raw_gateway_response jsonb NULL`, `paid_at timestamptz NULL`, `created_at/updated_at timestamptz`, `deleted_at timestamptz NULL`.
`tenant_payment_config`: `id`, `tenant_id`, `provider text` (`culqi`), `configured boolean default false`, `public_key text NULL` (non-secret), timestamps, `deleted_at`. Partial unique on `(tenant_id, provider) WHERE deleted_at IS NULL`. Both: `ENABLE/FORCE RLS`, `tenant_isolation` policy + grants to `app_rls` (mirror 0004). No `app_webhook` role, no `payment_webhook_read` policy, no column-grant on `external_id` (gate decision — fallback dropped).

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | fake adapter, both repos, use case | Vitest; `createFakeCulqiAdapter` script; assert `Result`, idempotent markPaid returns ok on 2nd call |
| Unit | `resolveSignature` reuse / culqi HMAC | valid/invalid/absent signature |
| Integration | full round-trip | Testcontainers PG: create link → pending row → signed POST → paid + `payment.paid` emitted once |
| Integration | RLS isolation | tenant B cannot read tenant A payment |
| Integration | HMAC reject + idempotency | bad sig → no mutation, still 200; duplicate POST → single paid, single emit |

## Migration / Rollout

Additive. `0005_payments.sql` via `pnpm migrate`. Rollback = revert commits + drop 2 tables. No backfill.

## Open Questions

- [ ] Confirm Culqi `metadata` passthrough + size limits before the real adapter slice (fake encodes the contract now).
- [ ] `CULQI_WEBHOOK_SECRET` global now; revisit per-tenant secret when encrypted creds ship.
