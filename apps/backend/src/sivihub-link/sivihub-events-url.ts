/**
 * sivihub-events-url.ts — validates the events URL the `sivihub:link` CLI stores
 * (spec: "validate https in production, allow http for localhost in dev").
 *
 * Rather than branch on NODE_ENV (the CLI does not otherwise depend on it), the rule
 * is host-scoped: https is required UNLESS the host is a well-known loopback address,
 * where a plain http dev server is expected. A malformed URL is rejected outright.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function validateEventsUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') {
    return true;
  }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    return true;
  }
  return false;
}
