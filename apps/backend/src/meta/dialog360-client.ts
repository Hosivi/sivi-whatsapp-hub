/**
 * dialog360-client.ts — Injectable 360dialog WhatsApp egress (functional DI, NO class).
 *
 * 360dialog uses the same WhatsApp Cloud API request/response format as Meta.
 * The only differences from createMetaClient are:
 *   - Base URL: `${baseUrl}/messages` — no phoneNumberId in the path (the API
 *     key identifies the WABA number; phoneNumberId is accepted in the input
 *     type for interface compatibility but is NOT used in the URL).
 *   - Auth header: `D360-API-KEY: <token>` instead of `Authorization: Bearer`.
 *
 * Sandbox base URL : https://waba-sandbox.360dialog.io/v1
 * Production base URL: https://waba-v2.360dialog.io
 *
 * The tenant's `whatsapp_accounts.access_token` column carries the D360-API-KEY.
 * No schema change is needed — the column is already present and tenant-scoped.
 *
 * Security invariants (identical to meta-client):
 *   - accessToken (D360-API-KEY) is NEVER logged, returned, or surfaced in errors
 *   - HTTP status is checked BEFORE the body is parsed
 *   - Only fetch rejections map to NETWORK_ERROR; non-2xx responses are META_API_ERROR
 */

import { err, ok } from '../shared/result.js';
import type { MetaClient, MetaSendError, SendTextInput, SendTextResult } from './meta-client.js';

// Re-export for convenience (callers that only use the 360dialog path can import from here).
export type { MetaClient, MetaSendError, SendTextInput, SendTextResult };

// ---------------------------------------------------------------------------
// Internal shared parse helper — mirrors the logic in createMetaClient
// (kept local to avoid coupling the two modules to a shared internal helper;
//  the spec allows minimal duplication to keep each client self-contained)
// ---------------------------------------------------------------------------

type MetaApiResponse = {
  messages?: Array<{ id?: string; message_status?: string }>;
  error?: { code?: number; message?: string };
};

async function parseApiResponse(res: Response): Promise<{ body: MetaApiResponse | null }> {
  const rawText = await res.text().catch(() => '');
  let body: MetaApiResponse | null = null;
  try {
    body = rawText === '' ? null : (JSON.parse(rawText) as MetaApiResponse);
  } catch {
    body = null;
  }
  return { body };
}

function buildApiError(status: number, body: MetaApiResponse | null): MetaSendError {
  return {
    code: 'META_API_ERROR',
    ...(body?.error?.code !== undefined ? { metaCode: body.error.code } : { metaCode: status }),
    ...(body?.error?.message !== undefined ? { detail: body.error.message } : {}),
  };
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

/**
 * 360dialog WhatsApp HTTP client.
 *
 * POSTs to `${baseUrl}/messages` with `D360-API-KEY: ${input.accessToken}`.
 * `input.phoneNumberId` is accepted (MetaClient interface) but ignored for the
 * URL — 360dialog derives the WABA number from the API key itself.
 *
 * Error mapping (same as createMetaClient):
 *   - fetch throws (transport failure)     → err({ code: 'NETWORK_ERROR', cause })
 *   - non-2xx + JSON body                  → err({ code: 'META_API_ERROR', metaCode, detail })
 *   - non-2xx + non-JSON body              → err({ code: 'META_API_ERROR', metaCode: httpStatus })
 *   - 2xx + messages[0].id present         → ok({ wamid, status })
 *   - 2xx + missing wamid                  → err({ code: 'META_API_ERROR', detail })
 */
export const createDialog360Client = (baseUrl: string): MetaClient => ({
  async sendText({
    accessToken,
    to,
    text,
  }: SendTextInput): Promise<import('../shared/result.js').Result<SendTextResult, MetaSendError>> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'd360-api-key': accessToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text },
        }),
      });
    } catch (cause) {
      return err({ code: 'NETWORK_ERROR' as const, cause });
    }

    const { body } = await parseApiResponse(res);

    if (!res.ok) {
      return err(buildApiError(res.status, body));
    }

    const wamid = body?.messages?.[0]?.id;
    if (!wamid) {
      return err({
        code: 'META_API_ERROR',
        detail: 'missing wamid in 2xx response',
      } as MetaSendError);
    }

    return ok({ wamid, status: body?.messages?.[0]?.message_status ?? 'accepted' });
  },
});
