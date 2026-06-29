/**
 * fake-culqi-adapter.test.ts — Unit tests for createFakeCulqiAdapter.
 *
 * Mirrors llm-adapter.unit.test.ts (createFakeLlmAdapter suite) pattern exactly.
 *
 * STRICT TDD — test written RED before implementation.
 *
 * Exercises:
 * - Default response: ok with stub url, externalId, raw
 * - queueResponse: overrides next call, then reverts to default
 * - calls[]: records each invocation in order
 * - script array: dequeues in order, wraps to default after exhaustion
 * - satisfies PaymentGatewayAdapter interface (compile-time check)
 */

import { describe, expect, it } from 'vitest';
import { err } from '../../shared/result.js';
import { createFakeCulqiAdapter } from '../fake-culqi-adapter.js';
import type { PaymentGatewayAdapter } from '../payment-gateway-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INPUT = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  paymentId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  amount: 1000,
  currency: 'PEN' as const,
  description: 'Test payment',
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createFakeCulqiAdapter', () => {
  it('(a) default response is ok with stub url and externalId', async () => {
    const fake = createFakeCulqiAdapter();
    const result = await fake.createPaymentLink(INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('never');
    expect(result.value.url).toBe('https://culqi.fake/pay/test-link');
    expect(result.value.externalId).toBe('fake-external-id');
    expect(result.value.raw).toBeDefined();
  });

  it('(b) queueResponse overrides next call, then reverts to default', async () => {
    const fake = createFakeCulqiAdapter();
    fake.queueResponse(err({ code: 'GATEWAY_API_ERROR', status: 422, detail: 'invalid amount' }));
    const first = await fake.createPaymentLink(INPUT);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('never');
    expect(first.error.code).toBe('GATEWAY_API_ERROR');
    // Second call — queue exhausted, back to default
    const second = await fake.createPaymentLink(INPUT);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('never');
    expect(second.value.url).toBe('https://culqi.fake/pay/test-link');
  });

  it('(c) calls[] records each invocation in order', async () => {
    const fake = createFakeCulqiAdapter();
    const input2 = { ...INPUT, amount: 2000, description: 'Second payment' };
    await fake.createPaymentLink(INPUT);
    await fake.createPaymentLink(input2);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.amount).toBe(1000);
    expect(fake.calls[1]?.amount).toBe(2000);
    expect(fake.calls[0]?.description).toBe('Test payment');
    expect(fake.calls[1]?.description).toBe('Second payment');
  });

  it('(d) script array: dequeues in order, wraps to default after exhaustion', async () => {
    const r1 = {
      ok: true as const,
      value: {
        url: 'https://culqi.fake/pay/scripted',
        externalId: 'scripted-ext-id',
        raw: {},
      },
    };
    const fake = createFakeCulqiAdapter([r1]);
    const first = await fake.createPaymentLink(INPUT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('never');
    expect(first.value.url).toBe('https://culqi.fake/pay/scripted');
    // Script exhausted → default
    const second = await fake.createPaymentLink(INPUT);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('never');
    expect(second.value.url).toBe('https://culqi.fake/pay/test-link');
  });

  it('(e) satisfies PaymentGatewayAdapter interface (compile-time check)', () => {
    const fake: PaymentGatewayAdapter = createFakeCulqiAdapter();
    expect(fake).toBeDefined();
    expect(typeof fake.createPaymentLink).toBe('function');
  });

  it('(f) queueResponse with network error returns Err(GATEWAY_NETWORK_ERROR)', async () => {
    const fake = createFakeCulqiAdapter();
    fake.queueResponse(err({ code: 'GATEWAY_NETWORK_ERROR', cause: new Error('timeout') }));
    const result = await fake.createPaymentLink(INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('never');
    expect(result.error.code).toBe('GATEWAY_NETWORK_ERROR');
    // Reverts to default
    const next = await fake.createPaymentLink(INPUT);
    expect(next.ok).toBe(true);
  });
});
