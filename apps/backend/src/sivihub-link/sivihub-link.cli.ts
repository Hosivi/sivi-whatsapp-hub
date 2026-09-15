/**
 * sivihub-link.cli.ts — `pnpm --filter backend sivihub:link` operator command
 * (ADR-0048 corte 1, spec "Vinculación en este corte").
 *
 * Stores or replaces the Hub's active link to a SiviHub tenant's events receiver —
 * the operator-run counterpart to SiviHub's `ventas:link-whatsapp`. The secret is
 * typed in by the operator (copied from the SiviHub command's one-time output) —
 * this command NEVER generates, echoes, or logs it.
 *
 * Usage:
 *   pnpm --filter backend sivihub:link \
 *     --tenant <uuid> --events-url <url> --secret <secret>
 */

import { fileURLToPath } from 'node:url';
import { loadEnv } from '../config/env.js';
import type { TenantRunner } from '../db/client.js';
import { createDbClient } from '../db/client.js';
import { validateEventsUrl } from './sivihub-events-url.js';
import type { SivihubLinkSecretCipher } from './sivihub-link-secret-cipher.js';
import { createSivihubLinkSecretCipher } from './sivihub-link-secret-cipher.js';
import { storeOrReplaceActiveLink } from './sivihub-links.repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Pure argv parser + validator — no I/O, easy to unit test.
// ---------------------------------------------------------------------------

export type ParsedLinkArgs = {
  readonly tenant: string;
  readonly eventsUrl: string;
  readonly secret: string;
};

export type ParseArgsError =
  | { readonly code: 'MISSING_ARG'; readonly flag: string }
  | { readonly code: 'INVALID_TENANT' }
  | { readonly code: 'INVALID_EVENTS_URL' };

function readFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        flags.set(key, value);
        i++;
      }
    }
  }
  return flags;
}

export function parseLinkArgs(argv: readonly string[]): ParsedLinkArgs | ParseArgsError {
  const flags = readFlags(argv);

  const tenant = flags.get('tenant');
  if (!tenant) {
    return { code: 'MISSING_ARG', flag: 'tenant' };
  }
  if (!UUID_RE.test(tenant)) {
    return { code: 'INVALID_TENANT' };
  }

  const eventsUrl = flags.get('events-url');
  if (!eventsUrl) {
    return { code: 'MISSING_ARG', flag: 'events-url' };
  }
  if (!validateEventsUrl(eventsUrl)) {
    return { code: 'INVALID_EVENTS_URL' };
  }

  const secret = flags.get('secret');
  if (!secret) {
    return { code: 'MISSING_ARG', flag: 'secret' };
  }

  return { tenant, eventsUrl, secret };
}

// ---------------------------------------------------------------------------
// Composed effectful path — encrypts + upserts via the tenant-scoped connection.
// ---------------------------------------------------------------------------

export async function runLinkCommand(
  args: ParsedLinkArgs,
  deps: {
    readonly withTenant: TenantRunner;
    readonly cipher: SivihubLinkSecretCipher;
  },
): Promise<{ id: string }> {
  const secretEncrypted = deps.cipher.encrypt(args.secret);
  return deps.withTenant(args.tenant, (tx) =>
    storeOrReplaceActiveLink(tx, args.tenant, args.eventsUrl, secretEncrypted),
  );
}

// ---------------------------------------------------------------------------
// Standalone script entrypoint
// ---------------------------------------------------------------------------

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url)
    .replace(/\\/g, '/')
    .endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const parsed = parseLinkArgs(process.argv.slice(2));
  if ('code' in parsed) {
    console.error(`[sivihub:link] invalid arguments: ${JSON.stringify(parsed)}`);
    process.exit(1);
  }

  const env = loadEnv();
  const db = createDbClient(env);
  const cipher = createSivihubLinkSecretCipher(env.SIVIHUB_LINK_ENCRYPTION_KEY);

  try {
    const { id } = await runLinkCommand(parsed, { withTenant: db.withTenant, cipher });
    // NEVER log the secret — only the non-sensitive confirmation.
    console.info(
      `[sivihub:link] linked tenant ${parsed.tenant} -> ${parsed.eventsUrl} (link ${id})`,
    );
  } finally {
    await db.close();
  }
  process.exit(0);
}
