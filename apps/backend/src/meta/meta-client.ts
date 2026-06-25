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
 * with Authorization: Bearer {accessToken}. NEVER logs the token.
 * - 2xx          → ok({ wamid: body.messages[0].id, status: body.messages[0].message_status ?? 'accepted' })
 * - non-2xx JSON → err({ code: 'META_API_ERROR', metaCode: body.error?.code, detail: body.error?.message })
 * - fetch throws / non-JSON body → err({ code: 'NETWORK_ERROR', cause })
 */
export const createMetaClient = (version: string): MetaClient => ({
  async sendText({ phoneNumberId, accessToken, to, text }) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: text },
          }),
        },
      );
      const body = (await res.json()) as MetaApiResponse;
      if (!res.ok) {
        return err({
          code: 'META_API_ERROR' as const,
          metaCode: body.error?.code,
          detail: body.error?.message,
        });
      }
      const wamid = body.messages?.[0]?.id;
      if (!wamid) {
        return err({ code: 'META_API_ERROR' as const, detail: 'missing wamid in 2xx response' });
      }
      return ok({ wamid, status: body.messages?.[0]?.message_status ?? 'accepted' });
    } catch (cause) {
      return err({ code: 'NETWORK_ERROR' as const, cause });
    }
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
