/**
 * sivihub-events-url.test.ts — Unit tests for the `sivihub:link` events-url guard.
 * Pure Vitest — no DB. STRICT TDD MODE — written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import { validateEventsUrl } from '../../src/sivihub-link/sivihub-events-url.js';

describe('validateEventsUrl', () => {
  it('accepts an https URL', () => {
    expect(validateEventsUrl('https://academia-ritmo.sivihub.pe/api/hooks/ventas/x')).toBe(true);
  });

  it('rejects a non-localhost http URL', () => {
    expect(validateEventsUrl('http://academia-ritmo.sivihub.pe/api/hooks/ventas/x')).toBe(false);
  });

  it('accepts an http URL on localhost (dev)', () => {
    expect(validateEventsUrl('http://localhost:3019/api/hooks/ventas/x')).toBe(true);
  });

  it('accepts an http URL on 127.0.0.1 (dev)', () => {
    expect(validateEventsUrl('http://127.0.0.1:3019/api/hooks/ventas/x')).toBe(true);
  });

  it('rejects a malformed URL', () => {
    expect(validateEventsUrl('not-a-url')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(validateEventsUrl('')).toBe(false);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(validateEventsUrl('ftp://localhost/x')).toBe(false);
  });
});
