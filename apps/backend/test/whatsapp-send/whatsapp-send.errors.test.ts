/**
 * whatsapp-send.errors.test.ts — Unit tests for WhatsappSendError union mappers.
 *
 * Pure Vitest — no I/O, no network, no DB.
 *
 * STRICT TDD MODE — tests written RED before implementation.
 */

import { describe, expect, it } from 'vitest';
import type { WhatsappSendError } from '../../src/whatsapp-send/whatsapp-send.errors.js';
import {
  mapMetaError,
  sendErrorToHttpStatus,
} from '../../src/whatsapp-send/whatsapp-send.errors.js';

// ---------------------------------------------------------------------------
// sendErrorToHttpStatus
// ---------------------------------------------------------------------------

describe('sendErrorToHttpStatus', () => {
  it('NO_ACTIVE_ACCOUNT → 404', () => {
    expect(sendErrorToHttpStatus({ code: 'NO_ACTIVE_ACCOUNT' })).toBe(404);
  });

  it('MULTIPLE_ACTIVE_ACCOUNTS → 422', () => {
    expect(sendErrorToHttpStatus({ code: 'MULTIPLE_ACTIVE_ACCOUNTS' })).toBe(422);
  });

  it('INVALID_RECIPIENT → 422', () => {
    expect(sendErrorToHttpStatus({ code: 'INVALID_RECIPIENT' })).toBe(422);
  });

  it('OUTBOUND_NOT_CONFIGURED → 422', () => {
    expect(sendErrorToHttpStatus({ code: 'OUTBOUND_NOT_CONFIGURED' })).toBe(422);
  });

  it('WINDOW_CLOSED → 422', () => {
    expect(sendErrorToHttpStatus({ code: 'WINDOW_CLOSED' })).toBe(422);
  });

  it('META_API_ERROR → 502', () => {
    expect(sendErrorToHttpStatus({ code: 'META_API_ERROR' })).toBe(502);
  });

  it('NETWORK_ERROR → 502', () => {
    expect(sendErrorToHttpStatus({ code: 'NETWORK_ERROR' })).toBe(502);
  });

  it('DB_ERROR → 500', () => {
    expect(sendErrorToHttpStatus({ code: 'DB_ERROR' })).toBe(500);
  });

  it('TypeScript exhaustiveness: result is assignable to 404 | 422 | 502 | 500', () => {
    // This is a compile-time check — if a case is missing, TS would flag it.
    const error: WhatsappSendError = { code: 'NO_ACTIVE_ACCOUNT' };
    const status: 404 | 422 | 502 | 500 = sendErrorToHttpStatus(error);
    expect([404, 422, 502, 500]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
// mapMetaError
// ---------------------------------------------------------------------------

describe('mapMetaError', () => {
  it('NETWORK_ERROR → { code: "NETWORK_ERROR" }', () => {
    const result = mapMetaError({ code: 'NETWORK_ERROR' });
    expect(result.code).toBe('NETWORK_ERROR');
  });

  it('META_API_ERROR with metaCode 131047 → { code: "WINDOW_CLOSED" }', () => {
    const result = mapMetaError({ code: 'META_API_ERROR', metaCode: 131047 });
    expect(result.code).toBe('WINDOW_CLOSED');
  });

  it('META_API_ERROR with metaCode 190 → { code: "META_API_ERROR" }', () => {
    const result = mapMetaError({ code: 'META_API_ERROR', metaCode: 190 });
    expect(result.code).toBe('META_API_ERROR');
  });

  it('META_API_ERROR with no metaCode → { code: "META_API_ERROR" }', () => {
    const result = mapMetaError({ code: 'META_API_ERROR' });
    expect(result.code).toBe('META_API_ERROR');
  });
});
