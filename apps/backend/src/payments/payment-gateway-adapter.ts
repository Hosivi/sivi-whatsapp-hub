/**
 * payment-gateway-adapter.ts — Injectable payment gateway egress (functional DI, NO class).
 *
 * Mirrors llm-adapter.ts structure established for LLM egress (ADR-0017).
 *
 * Exports:
 * - CreatePaymentLinkInput: input contract for link creation
 * - PaymentLink: successful response from the gateway (URL + external ref)
 * - GatewayError: typed error union (API error vs network error)
 * - PaymentGatewayAdapter: injectable interface (production + test double)
 *
 * Security invariants:
 * - No card data ever flows through this interface — gateway returns a hosted URL.
 * - Secret keys (private_key) are NEVER part of CreatePaymentLinkInput or PaymentLink.
 * - Provider-specific types never leak into calling code.
 */

import type { Result } from '../shared/result.js';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** Input for creating a payment link. tenantId + paymentId are embedded in metadata so the
 *  gateway webhook can resolve them without a cross-tenant DB read. */
export type CreatePaymentLinkInput = {
  /** Hub's internal tenant identifier — embedded in gateway metadata. */
  readonly tenantId: string;
  /** Hub's internal payment row UUID — embedded in gateway metadata. */
  readonly paymentId: string;
  /** Amount in minor units (e.g. cents for USD, centavos for PEN). */
  readonly amount: number;
  /** ISO 4217 currency code. */
  readonly currency: 'PEN' | 'USD';
  /** Human-readable description shown on the payment page. */
  readonly description: string;
};

/** Successful response from the payment gateway. */
export type PaymentLink = {
  /** Hosted payment page URL to share with the customer. */
  readonly url: string;
  /** Gateway-assigned external reference ID (stored in payments.external_id). */
  readonly externalId: string;
  /** Raw gateway response object for audit purposes (payments.raw_gateway_response). */
  readonly raw: unknown;
};

/** Typed error union — mirrors LlmError shape from llm-adapter.ts. */
export type GatewayError =
  | {
      readonly code: 'GATEWAY_API_ERROR';
      /** HTTP status returned by the gateway, if available. */
      readonly status?: number;
      /** Human-readable error detail from the gateway response. */
      readonly detail?: string;
    }
  | {
      readonly code: 'GATEWAY_NETWORK_ERROR';
      /** Underlying cause (network failure, timeout, etc.). */
      readonly cause?: unknown;
    };

// ---------------------------------------------------------------------------
// Injectable contract
// ---------------------------------------------------------------------------

/** The injectable contract. Production = real Culqi adapter; tests = createFakeCulqiAdapter. */
export type PaymentGatewayAdapter = {
  /**
   * Creates a hosted payment link via the configured gateway.
   * Returns Ok(PaymentLink) on success; Err(GatewayError) on failure.
   * NEVER throws — all errors are returned as typed Results.
   */
  createPaymentLink(input: CreatePaymentLinkInput): Promise<Result<PaymentLink, GatewayError>>;
};
