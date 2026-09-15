/**
 * sivihub-outbox-drain.unit.test.ts — Unit tests for the pure decision functions
 * behind the outbox drain (ADR-0048 corte 1, walking skeleton B3): the response
 * classification table from the spec, and the exponential backoff schedule.
 *
 * Pure Vitest — no DB, no network. STRICT TDD MODE — written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  classifyDeliveryOutcome,
  computeBackoffSeconds,
} from '../../src/sivihub-link/sivihub-outbox-drain.js';

describe('classifyDeliveryOutcome — spec response table', () => {
  it.each([200, 201, 202, 204, 299])('2xx (%d) -> delivered', (status) => {
    expect(classifyDeliveryOutcome(status)).toBe('delivered');
  });

  it.each([400, 401, 403])('%d -> dead (no retry — same body would fail again)', (status) => {
    expect(classifyDeliveryOutcome(status)).toBe('dead');
  });

  it('503 -> retry (SiviHub partition cron failed)', () => {
    expect(classifyDeliveryOutcome(503)).toBe('retry');
  });

  it.each([500, 502, 504])('other 5xx (%d) -> retry', (status) => {
    expect(classifyDeliveryOutcome(status)).toBe('retry');
  });

  it.each([408, 429])('%d -> retry (explicit spec decision)', (status) => {
    expect(classifyDeliveryOutcome(status)).toBe('retry');
  });

  it('"timeout" -> retry', () => {
    expect(classifyDeliveryOutcome('timeout')).toBe('retry');
  });

  it('"network_error" -> retry', () => {
    expect(classifyDeliveryOutcome('network_error')).toBe('retry');
  });

  it.each([404, 405, 410, 422])(
    'an unlisted 4xx (%d, never emitted by the contract) -> dead, same class as 400/401/403',
    (status) => {
      expect(classifyDeliveryOutcome(status)).toBe('dead');
    },
  );
});

describe('computeBackoffSeconds — exponential from 30s, capped at 1h', () => {
  it('attempt 1 -> 30s', () => {
    expect(computeBackoffSeconds(1)).toBe(30);
  });

  it('attempt 2 -> 60s', () => {
    expect(computeBackoffSeconds(2)).toBe(60);
  });

  it('attempt 3 -> 120s', () => {
    expect(computeBackoffSeconds(3)).toBe(120);
  });

  it('attempt 4 -> 240s', () => {
    expect(computeBackoffSeconds(4)).toBe(240);
  });

  it('caps at 3600s (1h) for large attempt numbers', () => {
    expect(computeBackoffSeconds(10)).toBe(3600);
    expect(computeBackoffSeconds(12)).toBe(3600);
  });
});

describe('MAX_ATTEMPTS', () => {
  it('is 12 (spec: "a los 12 intentos pasa a dead")', () => {
    expect(MAX_ATTEMPTS).toBe(12);
  });
});
