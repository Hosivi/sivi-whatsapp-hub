/**
 * api.ts — fetch wrappers for the dev console.
 *
 * CRITICAL: postWebhook sends the canonical payload STRING verbatim as the body.
 * Re-serializing it (JSON.stringify again) would produce a double-encoded string
 * and break the HMAC verification in the backend.
 */

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
const defaultTenantId =
  process.env.NEXT_PUBLIC_DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';

export interface SignedPayload {
  payload: string;
  signatureHeader: string;
  wamid: string;
}

export interface MessageDTO {
  wamid: string;
  name: string | null;
  phone: string;
  text: string | null;
  type: string;
  receivedAt: string;
  direction: string;
}

export interface SendOutboundResult {
  wamid: string;
  status: string;
}

/**
 * Thrown when sendOutbound encounters a typed backend failure or a transport error.
 * `code` matches the backend's error code (e.g. 'WINDOW_CLOSED', 'NETWORK_ERROR').
 */
export class SendOutboundError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'SendOutboundError';
  }
}

/**
 * Calls POST /dev/webhook-sign to get a signed Meta-shaped payload.
 * Returns the canonical payload string + the HMAC signature header.
 */
export async function signWebhook(
  phone: string,
  profileName: string | undefined,
  text: string,
): Promise<SignedPayload> {
  const res = await fetch(`${apiUrl}/dev/webhook-sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, profileName, text }),
  });

  if (!res.ok) {
    throw new Error(`sign-webhook failed: ${res.status}`);
  }

  return res.json() as Promise<SignedPayload>;
}

/**
 * Posts the SIGNED canonical payload string to the REAL webhook.
 *
 * IMPORTANT: payloadString is the exact canonical string returned by the signing
 * proxy. It MUST be sent verbatim — do NOT JSON.stringify it again or the
 * HMAC signature will not match what the backend verifies.
 */
export async function postWebhook(payloadString: string, signatureHeader: string): Promise<void> {
  const res = await fetch(`${apiUrl}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signatureHeader,
    },
    // Send the canonical string as-is — NOT re-serialized.
    body: payloadString,
  });

  if (!res.ok) {
    throw new Error(`post-webhook failed: ${res.status}`);
  }
}

/**
 * Fetches persisted messages for the current tenant from GET /whatsapp-messages.
 */
export async function getMessages(tenantId: string = defaultTenantId): Promise<MessageDTO[]> {
  const res = await fetch(`${apiUrl}/whatsapp-messages`, {
    headers: { 'X-Tenant-Id': tenantId },
  });

  if (!res.ok) {
    throw new Error(`get-messages failed: ${res.status}`);
  }

  const body = (await res.json()) as { data: MessageDTO[] };
  return body.data;
}

/**
 * Sends an outbound WhatsApp text message via POST /whatsapp-send.
 * - On 200: returns { wamid, status } as SendOutboundResult.
 * - On non-2xx: throws SendOutboundError with the backend's error code.
 * - On network/parse failure: throws SendOutboundError('NETWORK_ERROR').
 */
export async function sendOutbound(
  tenantId: string,
  to: string,
  text: string,
): Promise<SendOutboundResult> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/whatsapp-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
      },
      body: JSON.stringify({ to, text }),
    });
  } catch {
    throw new SendOutboundError('NETWORK_ERROR');
  }

  let body: { wamid?: string; status?: string; error?: string } = {};
  try {
    body = (await res.json()) as { wamid?: string; status?: string; error?: string };
  } catch {
    if (!res.ok) {
      throw new SendOutboundError('META_API_ERROR');
    }
    throw new SendOutboundError('NETWORK_ERROR');
  }

  if (!res.ok) {
    throw new SendOutboundError(body.error ?? 'META_API_ERROR');
  }

  return { wamid: body.wamid ?? '', status: body.status ?? 'accepted' };
}
