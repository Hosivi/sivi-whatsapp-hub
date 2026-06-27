# Tasks: payment-link-core (Corte 3, slice 1)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~840 (PR1 ~350 / PR2 ~490) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 (data layer) → PR2 (behavior) |
| Delivery strategy | stacked-to-main |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

> **Gatekeeper rule**: PR2 MUST NOT start until PR1 is merged to main.

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Port + fake adapter + schemas + migration + repos | PR1 | Base = main; includes unit + integration tests for repos |
| 2 | Use case + event bus + webhook route + wiring + full integration tests | PR2 | Base = main (after PR1 merged) |

---

## PR1 — Data Layer (~350 lines)

### Phase 1: Dependency and Event Bus Seam

- [ ] 1.1 Install `mitt`: `pnpm --filter @sivihub/whatsapp-hub-backend add mitt`. Verify it appears in `apps/backend/package.json`.
- [ ] 1.2 Create `apps/backend/src/events/event-bus.ts`: export `AppEvents` type (`'payment.paid'` payload), `EventBus` interface, and `createEventBus()` factory (wraps `mitt()`).

### Phase 2: Port and Fake Adapter

- [ ] 2.1 Create `apps/backend/src/payments/payment-gateway-adapter.ts`: export `CreatePaymentLinkInput`, `PaymentLink`, `GatewayError` union, and `PaymentGatewayAdapter` interface. Mirror `llm-adapter.ts` structure exactly.
- [ ] 2.2 Create `apps/backend/src/payments/fake-culqi-adapter.ts`: export `createFakeCulqiAdapter()` returning adapter + `calls: CreatePaymentLinkInput[]` + `queueResponse(r)`. Mirror `createFakeLlmAdapter` pattern.
- [ ] 2.3 RED: write `apps/backend/src/payments/__tests__/fake-culqi-adapter.test.ts` — assert `calls[]` records inputs, `queueResponse` controls `Ok`/`Err` outcomes.
- [ ] 2.4 GREEN: confirm fake adapter tests pass (`pnpm --filter @sivihub/whatsapp-hub-backend test`).

### Phase 3: Schemas and Migration

- [ ] 3.1 Create `apps/backend/src/db/schema/payments.schema.ts`: `payments` pgTable (uuid PK, `tenant_id`, `amount` integer minor-units, `currency`, `status` enum `pending|paid|failed|expired`, `external_id` text unique, `reference` text, `source_entity_type` text NULL, `source_entity_id` uuid NULL, `metadata` jsonb, `raw_gateway_response` jsonb NULL, `paid_at` timestamptz NULL, `created_at`, `updated_at`, `deleted_at`). Export `mapRowToPayment`.
- [ ] 3.2 Create `apps/backend/src/db/schema/tenant-payment-config.schema.ts`: `tenant_payment_config` pgTable (uuid PK, `tenant_id`, `provider` text `culqi`, `configured` boolean default false, `public_key` text NULL, timestamps, `deleted_at`). Partial unique index on `(tenant_id, provider) WHERE deleted_at IS NULL`. Mirror `tenant-ai-config.schema.ts`.
- [ ] 3.3 Create `apps/backend/drizzle/0005_payments.sql`: CREATE TABLE `payments` + `tenant_payment_config`; ENABLE/FORCE RLS on both; `tenant_isolation` policy on both; GRANT to `app_rls`. **No `app_webhook` role, no `payment_webhook_read` policy.** Use next sequential migration number; verify against existing migrations.
- [ ] 3.4 Extend `apps/backend/src/test/_helpers/test-db.ts`: add `0005_payments.sql` to `MIGRATION_FILES` and add `payments`, `tenant_payment_config` to the truncate list.

### Phase 4: Repositories and Integration Tests

- [ ] 4.1 Create `apps/backend/src/payments/payment-config.repository.ts`: `createPaymentConfigRepository(db)` with `save(config): Promise<Result<TenantPaymentConfig, DbError>>` and `find(tenantId): Promise<Result<TenantPaymentConfig | null, DbError>>`. Use `withTenant`; no `WHERE tenant_id`.
- [ ] 4.2 Create `apps/backend/src/payments/payments.repository.ts`: `createPaymentsRepository(db)` with `createRecord`, `markPaid` (`UPDATE ... WHERE id=? AND status='pending' RETURNING *`, returns `rowCount`), `findById`, `findByReference`. Use `withTenant`; no `WHERE tenant_id`.
- [ ] 4.3 RED: write `apps/backend/src/payments/__tests__/payments.repository.test.ts` (Testcontainers): assert `createRecord` inserts `pending`, `markPaid` transitions to `paid` and returns `rowCount=1`, second `markPaid` call returns `rowCount=0` (idempotent), cross-tenant query returns zero rows (RLS isolation).
- [ ] 4.4 RED: write `apps/backend/src/payments/__tests__/payment-config.repository.test.ts` (Testcontainers): assert `save` upserts config, `find` returns null when absent, RLS isolation (tenant B cannot read tenant A config).
- [ ] 4.5 GREEN: confirm all repository integration tests pass.

---

## PR2 — Behavior (~490 lines)

> Requires PR1 merged to main before starting.

### Phase 5: Use Case

- [ ] 5.1 Create `apps/backend/src/payments/create-payment-link.use-case.ts`: `createPaymentLinkUseCase(deps)` — (1) `configRepo.find` → `Err({ code: 'GATEWAY_NOT_CONFIGURED' })` when missing or `configured=false`; (2) `adapter.createPaymentLink` → propagate `GatewayError` on `Err`; (3) `paymentsRepo.createRecord(pending)` with embedded `tenantId`+`paymentId` in metadata; (4) return `Ok({ url, paymentId })`. No `WHERE tenant_id`. Return `Result<T, E>`, never throw.
- [ ] 5.2 RED: write `apps/backend/src/payments/__tests__/create-payment-link.use-case.test.ts` — assert: gateway-not-configured → typed Err, no row inserted; adapter failure → Err, no row; happy path → `pending` row + `Ok` with url.
- [ ] 5.3 GREEN: confirm use case tests pass.

### Phase 6: Webhook Service and Route

- [ ] 6.1 Create `apps/backend/src/webhooks/culqi.service.ts`: `createCulqiWebhookService(deps)` — (1) raw `arrayBuffer()` before any parsing; (2) HMAC-SHA256 `timingSafeEqual` against `CULQI_WEBHOOK_SECRET` → `400` on failure; (3) JSON parse; (4) extract `metadata.tenantId` + `paymentId`; (5) absent/unknown tenant → log + return `200` no-op; (6) `withTenant(tenantId, markPaid)` → check `rowCount > 0` before emitting `payment.paid`; (7) ack `200` always after valid HMAC. Deps: `paymentsRepo`, `eventBus`, `db`.
- [ ] 6.2 Create `apps/backend/src/webhooks/culqi.route.ts`: Hono route `POST /webhooks/culqi` reading raw body; delegate to `culqiWebhookService`. No body parsing middleware before this route.
- [ ] 6.3 Modify `apps/backend/src/config/env.ts`: add `CULQI_WEBHOOK_SECRET` (required string). Add `// mock-first; revisit per-tenant before real-Culqi slice` comment.
- [ ] 6.4 Modify `apps/backend/src/app.ts` and/or `main.ts`: add `eventBus` to `AppDeps`, wire `createFakeCulqiAdapter()` as the gateway adapter behind a `USE_FAKE_ADAPTER` / dev gate, register `culqi.route.ts`.

### Phase 7: Integration Tests — Full Round-Trip

- [ ] 7.1 RED: write `apps/backend/src/payments/__tests__/culqi-webhook.integration.test.ts` (Testcontainers): assert full round-trip — create link → `pending` row → valid signed POST → `paid` row + `payment.paid` emitted once.
- [ ] 7.2 RED: invalid HMAC → HTTP 400, no DB mutation.
- [ ] 7.3 RED: duplicate webhook → idempotent — single `paid` row, `payment.paid` emitted exactly once across both calls.
- [ ] 7.4 RED: gateway not configured → `createPaymentLinkUseCase` returns typed Err, no row.
- [ ] 7.5 RED: unknown `metadata.tenantId` → HTTP 200 no-op, no DB mutation, log recorded.
- [ ] 7.6 RED: RLS isolation — tenant B cannot read or mutate tenant A's `payments` row.
- [ ] 7.7 GREEN: all integration tests pass.

### Phase 8: Green Gate

- [ ] 8.1 Run full test suite: `pnpm --filter @sivihub/whatsapp-hub-backend test` — all tests green.
- [ ] 8.2 Run typecheck: `pnpm --filter @sivihub/whatsapp-hub-backend typecheck` (or `tsc --noEmit`) — zero errors.
- [ ] 8.3 Confirm no `WHERE tenant_id` in any new file (`rg 'WHERE tenant_id'` in `src/payments` and `src/webhooks`).
- [ ] 8.4 Confirm no `throw` in domain files (use case, repos, service) — only `Result<T,E>`.
