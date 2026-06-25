/**
 * whatsapp-send.errors.ts — WhatsappSendError discriminated union and HTTP mappers.
 *
 * sendErrorToHttpStatus: exhaustive switch over the union → HTTP status code.
 *   TypeScript will flag a missing case if the union grows.
 *
 * mapMetaError: maps a MetaSendError (from MetaClient) to a WhatsappSendError.
 *   - NETWORK_ERROR stays NETWORK_ERROR
 *   - META_API_ERROR with metaCode 131047 → WINDOW_CLOSED (24h window closed)
 *   - other META_API_ERROR → META_API_ERROR
 */

import type { MetaSendError } from '../meta/meta-client.js';

// ---------------------------------------------------------------------------
// Error union
// ---------------------------------------------------------------------------

export type WhatsappSendError =
  | { readonly code: 'NO_ACTIVE_ACCOUNT' } // 0 active accounts
  | { readonly code: 'MULTIPLE_ACTIVE_ACCOUNTS' } // >1 active accounts (misconfig)
  | { readonly code: 'INVALID_RECIPIENT' } // `to` is not a valid Peru-normalizable number
  | { readonly code: 'OUTBOUND_NOT_CONFIGURED' } // access_token IS NULL
  | { readonly code: 'WINDOW_CLOSED' } // Meta 131047 (24h window)
  | { readonly code: 'META_API_ERROR' } // any other Meta API error
  | { readonly code: 'NETWORK_ERROR' } // transport failure / timeout
  | { readonly code: 'DB_ERROR'; readonly cause?: unknown }; // persist failed (send already done)

// ---------------------------------------------------------------------------
// HTTP status mapper (exhaustive)
// ---------------------------------------------------------------------------

export function sendErrorToHttpStatus(error: WhatsappSendError): 404 | 422 | 502 | 500 {
  switch (error.code) {
    case 'NO_ACTIVE_ACCOUNT':
      return 404;
    case 'MULTIPLE_ACTIVE_ACCOUNTS':
      return 422;
    case 'INVALID_RECIPIENT':
      return 422;
    case 'OUTBOUND_NOT_CONFIGURED':
      return 422;
    case 'WINDOW_CLOSED':
      return 422;
    case 'META_API_ERROR':
      return 502;
    case 'NETWORK_ERROR':
      return 502;
    case 'DB_ERROR':
      return 500;
  }
}

// ---------------------------------------------------------------------------
// Meta error → send error mapper
// ---------------------------------------------------------------------------

/**
 * Maps a MetaSendError from MetaClient to a WhatsappSendError.
 *
 * - NETWORK_ERROR → { code: 'NETWORK_ERROR' }
 * - META_API_ERROR with metaCode === 131047 → { code: 'WINDOW_CLOSED' }
 * - other META_API_ERROR → { code: 'META_API_ERROR' }
 */
export function mapMetaError(e: MetaSendError): WhatsappSendError {
  if (e.code === 'NETWORK_ERROR') {
    return { code: 'NETWORK_ERROR' };
  }
  // META_API_ERROR — check for 131047 (window closed)
  if (e.metaCode === 131047) {
    return { code: 'WINDOW_CLOSED' };
  }
  return { code: 'META_API_ERROR' };
}
