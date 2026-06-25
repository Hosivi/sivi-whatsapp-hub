/**
 * meta-client.ts — Injectable Meta Cloud API egress (functional DI, NO class).
 *
 * Exports:
 * - MetaClient: injectable contract (interface)
 * - createMetaClient(version): real fetch-based implementation
 * - createFakeMetaClient(response?): test double with calls[] and queueError()
 *
 * Security invariants:
 * - accessToken is NEVER logged anywhere in this module
 * - raw_payload stored downstream contains only the Meta response, not the credential
 * - version is injected from WHATSAPP_META_API_VERSION env var (never hardcoded)
 */

import { err, ok } from '../shared/result.js';
import type { Result } from '../shared/result.js';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** Input to a single text send. accessToken is the per-tenant Bearer credential. */
export type SendTextInput = {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly to: string;
  readonly text: string;
};

/** Success shape: Meta's wamid + the messaging status it reports. */
export type SendTextResult = {
  readonly wamid: string;
  readonly status: string; // 'accepted' (Meta echoes messages[0].id; status from response)
};

/** Egress failure union — transport vs. API error are distinguished by `metaCode`. */
export type MetaSendError =
  | { readonly code: 'META_API_ERROR'; readonly metaCode?: number; readonly detail?: string }
  | { readonly code: 'NETWORK_ERROR'; readonly cause?: unknown };

// ---------------------------------------------------------------------------
// Injectable contract
// ---------------------------------------------------------------------------

/** The injectable contract. Production = createMetaClient; tests = createFakeMetaClient. */
export type MetaClient = {
  sendText(input: SendTextInput): Promise<Result<SendTextResult, MetaSendError>>;
};

// ---------------------------------------------------------------------------
// Internal Meta API response shape
// ---------------------------------------------------------------------------

type MetaApiResponse = {
  messages?: Array<{ id?: string; message_status?: string }>;
  error?: { code?: number; message?: string };
};

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

/**
 * Real HTTP impl. Builds POST https://graph.facebook.com/{version}/{phoneNumberId}/messages
 * with Authorization: Bearer {accessToken}. NEVER logs or returns the token.
 *
 * Ordering matters — the HTTP status is checked BEFORE the body is parsed:
 * - fetch throws (transport failure)        → err({ code: 'NETWORK_ERROR', cause })
 * - non-2xx + JSON body                     → err({ code: 'META_API_ERROR', metaCode, detail })
 * - non-2xx + non-JSON body                 → err({ code: 'META_API_ERROR', metaCode: httpStatus })
 * - 2xx + JSON with messages[0].id          → ok({ wamid, status })
 * - 2xx + non-JSON / missing wamid          → err({ code: 'META_API_ERROR', detail })
 *
 * A non-2xx response is NEVER mapped to NETWORK_ERROR — only a genuine transport
 * failure (fetch rejecting) is. The access token never appears in any returned
 * error: only the HTTP status and Meta's own error body are surfaced.
 */
export const createMetaClient = (version: string): MetaClient => ({
  async sendText({ phoneNumberId, accessToken, to, text }) {
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text, preview_url: false },
        }),
      });
    } catch (cause) {
      // Only genuine transport failures (fetch rejecting) are NETWORK_ERROR.
      return err({ code: 'NETWORK_ERROR' as const, cause });
    }

    // Read the body defensively — a non-JSON body must not be confused with a
    // transport failure. Parse from text so a malformed body never throws here.
    const rawText = await res.text().catch(() => '');
    let body: MetaApiResponse | null = null;
    try {
      body = rawText === '' ? null : (JSON.parse(rawText) as MetaApiResponse);
    } catch {
      body = null;
    }

    // Check the HTTP status FIRST. A non-2xx response is a Meta API error
    // regardless of whether the body parsed as JSON.
    if (!res.ok) {
      // Use explicit undefined checks for exactOptionalPropertyTypes compliance.
      // Fall back to the HTTP status as metaCode when no Meta error code is present.
      const errorObj: MetaSendError = {
        code: 'META_API_ERROR',
        ...(body?.error?.code !== undefined
          ? { metaCode: body.error.code }
          : { metaCode: res.status }),
        ...(body?.error?.message !== undefined ? { detail: body.error.message } : {}),
      };
      return err(errorObj);
    }

    // 2xx — require a parseable body with a wamid.
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

// ---------------------------------------------------------------------------
// Test double (fake)
// ---------------------------------------------------------------------------

/**
 * Test double. Deterministic, controllable. Default = ok({ wamid: 'wamid-fake-1', status: 'accepted' }).
 * Override the response to simulate any Meta/transport outcome; record calls for assertions.
 *
 * queueError(e) sets the NEXT response to err(e). The queued error is consumed once.
 * After consumption, subsequent calls revert to the default ok response.
 */
export const createFakeMetaClient = (
  defaultResponse: Result<SendTextResult, MetaSendError> = ok({
    wamid: 'wamid-fake-1',
    status: 'accepted',
  }),
): MetaClient & { calls: SendTextInput[]; queueError(e: MetaSendError): void } => {
  const calls: SendTextInput[] = [];
  let queued: Result<SendTextResult, MetaSendError> | null = null;

  return {
    calls,
    queueError(e: MetaSendError) {
      queued = err(e);
    },
    async sendText(input) {
      calls.push(input);
      if (queued !== null) {
        const response = queued;
        queued = null;
        return response;
      }
      return defaultResponse;
    },
  };
};
