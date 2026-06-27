# Payment Link Specification

## Purpose

Defines requirements for the `payment-link` capability: configure a tenant's payment gateway, create a payment link for a sale, persist its lifecycle (`pending → paid | failed | expired`), and reconcile payment via an idempotent, HMAC-verified gateway webhook that emits `payment.paid`.

---

## Requirements

### Requirement: Gateway Config Guard

The system MUST prevent payment link creation when the tenant's gateway is not configured. `createPaymentLink` MUST return a typed `Result` error (not throw) when `tenant_payment_config.configured = false` or no config row exists for the tenant. The system MUST NOT expose card data or custody funds at any point.

#### Scenario: Gateway not configured

- GIVEN a tenant has no `tenant_payment_config` row, or `configured = false`
- WHEN `createPaymentLink` is called for that tenant
- THEN the use case returns `Err({ code: 'GATEWAY_NOT_CONFIGURED' })`
- AND no `payments` row is created

#### Scenario: Gateway configured

- GIVEN a tenant has `tenant_payment_config.configured = true`
- WHEN `createPaymentLink` is called with a valid amount and optional source
- THEN the adapter is invoked and the use case proceeds to the create step

---

### Requirement: Create Payment Link

The system MUST create a `payments` row with `status = 'pending'` and embed `tenantId` + `paymentId` in the gateway metadata when a link is successfully created. The use case MUST return a `Result<PaymentLink, GatewayError>` with the link URL. Source entity (`source_entity_type`, `source_entity_id`) is optional and MUST be stored as-is (nullable). All queries MUST use `withTenant` (RLS); no `WHERE tenant_id` clause is permitted.

#### Scenario: Happy path — link created

- GIVEN a tenant with `configured = true`
- WHEN `createPaymentLink({ amount, source_entity_type?, source_entity_id? })` is called
- THEN a `payments` row is inserted with `status = 'pending'`, embedded metadata, and the optional source fields
- AND the use case returns `Ok({ url: '<link-url>', paymentId: '<uuid>' })`

#### Scenario: Adapter failure

- GIVEN a tenant with `configured = true` and the adapter is programmed to fail
- WHEN `createPaymentLink` is called
- THEN the use case returns `Err({ code: 'ADAPTER_ERROR', detail: ... })`
- AND no `payments` row is persisted

---

### Requirement: Webhook HMAC Verification

`POST /webhooks/culqi` MUST read the raw request body as bytes before any parsing. The endpoint MUST verify HMAC-SHA256 over the raw body using the tenant's gateway secret. Requests with an invalid or missing signature MUST be rejected with HTTP 400. Timing-safe comparison MUST be used.

#### Scenario: Valid HMAC

- GIVEN a webhook POST with a correct HMAC-SHA256 signature
- WHEN the endpoint receives it
- THEN the signature check passes and processing continues

#### Scenario: Invalid HMAC

- GIVEN a webhook POST with a tampered or missing signature
- WHEN the endpoint receives it
- THEN the endpoint returns HTTP 400 and processing stops immediately

---

### Requirement: Tenant Resolution from Metadata

The endpoint MUST resolve the tenant ONLY from the `tenantId` embedded in the gateway metadata (`metadata.tenantId`). There is NO fallback to `external_id`. When the HMAC is valid but `metadata.tenantId` is absent or does not match a known tenant, the endpoint MUST log the event and return HTTP 200 with no state change (no retry storm).

#### Scenario: Metadata resolution success

- GIVEN a valid webhook with `metadata.tenantId` matching a known tenant
- WHEN the endpoint processes it
- THEN the correct tenant context is set for the subsequent `markPaid` call

#### Scenario: Unknown reference

- GIVEN a valid HMAC but `metadata.tenantId` is absent or does not match any known tenant
- WHEN the endpoint processes it
- THEN the endpoint logs the event and returns HTTP 200 with no state change

---

### Requirement: Idempotent markPaid

The endpoint MUST mark the matching `payments` row `paid` only when its current `status = 'pending'`. A retried or duplicate webhook for an already-`paid` row MUST be a silent no-op returning HTTP 200. The endpoint MUST emit `payment.paid` on the `mitt` event bus exactly once per transition.

#### Scenario: First webhook — pending → paid

- GIVEN a `payments` row with `status = 'pending'`
- WHEN the endpoint receives a valid, verified paid event
- THEN the row transitions to `status = 'paid'`
- AND `payment.paid` is emitted once

#### Scenario: Duplicate webhook — already paid

- GIVEN the same `payments` row already has `status = 'paid'`
- WHEN the endpoint receives the same event again
- THEN no state transition occurs, `payment.paid` is NOT emitted again
- AND the endpoint returns HTTP 200

---

### Requirement: RLS Tenant Isolation

The system MUST enforce that tenant B cannot read, transition, or emit events for tenant A's `payments` rows. All repository calls MUST run inside `withTenant` context. RLS `tenant_isolation` policies on `payments` and `tenant_payment_config` MUST be applied via migration from day 1.

#### Scenario: Cross-tenant access attempt

- GIVEN tenant B's context is active
- WHEN a query targets a `payments` row owned by tenant A
- THEN RLS returns zero rows and no state change occurs

---

### Requirement: Payment Lifecycle States

The `payments` row MUST follow this state machine: `pending → paid | failed | expired`. Transitions MUST be append-only (no backwards transitions). The spec does not define `failed` and `expired` triggers in this slice (deferred); the schema MUST support them.

#### Scenario: State column enforces valid values

- GIVEN a `payments` row
- WHEN its `status` column is inspected
- THEN it contains exactly one of: `pending`, `paid`, `failed`, `expired`
