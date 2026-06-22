/**
 * result-to-response.test.ts — Unit tests for the ContactError → HTTP status mapper.
 *
 * Docker-free: no Testcontainers, pure Vitest.
 *
 * Each ContactError code must map to the right HTTP status and body shape.
 */

import { describe, expect, it } from 'vitest';
import { resultToHttpStatus } from './contacts.route.js';

describe('resultToHttpStatus — ContactError → HTTP status mapping', () => {
  it('maps CONTACT_ALREADY_EXISTS to 409', () => {
    expect(resultToHttpStatus({ code: 'CONTACT_ALREADY_EXISTS' })).toBe(409);
  });

  it('maps CONTACT_NOT_FOUND to 404', () => {
    expect(resultToHttpStatus({ code: 'CONTACT_NOT_FOUND' })).toBe(404);
  });

  it('maps INVALID_PHONE to 422', () => {
    expect(resultToHttpStatus({ code: 'INVALID_PHONE' })).toBe(422);
  });

  it('maps DB_ERROR to 500', () => {
    expect(resultToHttpStatus({ code: 'DB_ERROR' })).toBe(500);
  });
});
