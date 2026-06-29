/**
 * fake-culqi-adapter.ts — Test double for PaymentGatewayAdapter.
 *
 * Mirrors createFakeLlmAdapter from llm-adapter.ts exactly:
 * - calls[] records every createPaymentLink invocation in order.
 * - queueResponse(r) pre-loads one response consumed on the next call.
 * - script[] provides ordered responses that are dequeued on successive calls.
 * - Default response: ok({ url, externalId, raw }) with deterministic stub values.
 *
 * Usage in tests:
 *   const fake = createFakeCulqiAdapter();
 *   fake.queueResponse(err({ code: 'GATEWAY_API_ERROR', status: 422 }));
 *   const result = await fake.createPaymentLink({ ... });
 *   expect(result.ok).toBe(false);
 *   expect(fake.calls).toHaveLength(1);
 */

import { ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';
import type {
  CreatePaymentLinkInput,
  GatewayError,
  PaymentGatewayAdapter,
  PaymentLink,
} from './payment-gateway-adapter.js';

// ---------------------------------------------------------------------------
// Default stub response
// ---------------------------------------------------------------------------

const DEFAULT_RESPONSE: Result<PaymentLink, GatewayError> = ok({
  url: 'https://culqi.fake/pay/test-link',
  externalId: 'fake-external-id',
  raw: { provider: 'culqi-fake', status: 'created' },
});

// ---------------------------------------------------------------------------
// Factory — test double
// ---------------------------------------------------------------------------

/**
 * Test double. Deterministic, programmable, records calls.
 *
 * Default = ok({ url: 'https://culqi.fake/pay/test-link', externalId: 'fake-external-id', raw: {...} }).
 *
 * Behaviour:
 * - If a `script` array is provided, responses are dequeued in order. Once
 *   exhausted, subsequent calls return the default.
 * - queueResponse(r) pre-loads one response that is consumed on the next call
 *   (ahead of the script queue). After consumption, reverts to the next script
 *   item or the default.
 * - calls[] records every invocation in order for assertions.
 *
 * Mirrors createFakeLlmAdapter's API design.
 */
export const createFakeCulqiAdapter = (
  script?: Array<Result<PaymentLink, GatewayError>>,
): PaymentGatewayAdapter & {
  calls: CreatePaymentLinkInput[];
  queueResponse(r: Result<PaymentLink, GatewayError>): void;
} => {
  const calls: CreatePaymentLinkInput[] = [];
  const queue: Array<Result<PaymentLink, GatewayError>> = script ? [...script] : [];
  let oneOff: Result<PaymentLink, GatewayError> | null = null;

  return {
    calls,

    queueResponse(r) {
      oneOff = r;
    },

    async createPaymentLink(input) {
      calls.push(input);

      if (oneOff !== null) {
        const response = oneOff;
        oneOff = null;
        return response;
      }

      if (queue.length > 0) {
        return queue.shift()!;
      }

      return DEFAULT_RESPONSE;
    },
  };
};
