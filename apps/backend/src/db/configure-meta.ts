/**
 * configure-meta.ts — Wire the seeded dev tenant to a REAL Meta WhatsApp Cloud API number.
 *
 * Loads the credentials of Meta's free *test number* (phone_number_id, display
 * number, WABA id, System User access token) into the dev tenant created by
 * seed-dev.ts, so inbound messages and replies run end-to-end against the real Graph API.
 * It never switches the AI on: AI replies need AI_REPLY_ENABLED=true and an enabled
 * tenant_ai_config row, both off by default until SiviHub's agent takes over (E4).
 * Step-by-step guide: Docs/runbooks/meta-test-number.md.
 *
 * Inputs come ONLY from environment variables — never from CLI args:
 *   DATABASE_ADMIN_URL, META_PHONE_NUMBER_ID, META_DISPLAY_PHONE_NUMBER,
 *   META_WABA_ID, META_ACCESS_TOKEN
 *
 * In ONE transaction (all checks run before any write):
 * - whatsapp_accounts: exactly one active row → update it; none → insert one;
 *   more than one → fail (the send path requires exactly one — resolveActiveAccount).
 * - tenant_ai_config: one live row → left untouched (never rewritten);
 *   none → insert the seed defaults with enabled = false; more than one → fail
 *   (getTenantAiConfig requires exactly one).
 *
 * Tenant scoping: like migrate.ts and seed-dev.ts this is a privileged bootstrap
 * script on DATABASE_ADMIN_URL. The admin role bypasses RLS, and no helper sets
 * app.current_tenant on that handle (withTenant lives on the app_rls pool), so
 * every statement is pinned to DEV_TENANT_ID explicitly. Runtime code keeps
 * going through withTenant + RLS.
 *
 * Secrets: the access token is never printed. The summary omits it, no error
 * variant carries it, and unexpected errors are redacted before printing.
 *
 * Usage:
 *   pnpm --filter @sivihub/whatsapp-hub-backend configure:meta
 */

import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { z } from 'zod';
import { type Result, err, ok } from '../shared/result.js';
import {
  DEV_AI_BUSINESS_INFO,
  DEV_AI_BUSINESS_NAME,
  DEV_AI_VERTICAL,
  DEV_TENANT_ID,
} from './seed-dev.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MetaCredentials = {
  readonly phoneNumberId: string;
  readonly displayPhoneNumber: string;
  readonly wabaId: string;
  readonly accessToken: string;
};

export type ConfigureMetaInput = {
  readonly databaseAdminUrl: string;
  readonly credentials: MetaCredentials;
};

/** Success summary. Deliberately has NO access token field. */
export type ConfigureMetaSummary = {
  readonly tenantId: string;
  readonly phoneNumberId: string;
  readonly displayPhoneNumber: string;
  readonly wabaId: string;
  readonly account: 'updated' | 'inserted';
  readonly aiConfig: 'unchanged' | 'inserted';
};

/** Expected failures. No variant carries a credential value. */
export type ConfigureMetaError =
  | { readonly code: 'INVALID_ENV'; readonly variables: ReadonlyArray<string> }
  | { readonly code: 'DEV_TENANT_NOT_SEEDED'; readonly tenantId: string }
  | { readonly code: 'MULTIPLE_ACTIVE_ACCOUNTS'; readonly count: number }
  | { readonly code: 'MULTIPLE_AI_CONFIGS'; readonly count: number }
  | { readonly code: 'PHONE_NUMBER_ID_IN_USE'; readonly phoneNumberId: string };

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

const requiredString = z.string().trim().min(1);

const configureMetaEnvSchema = z.object({
  DATABASE_ADMIN_URL: requiredString,
  META_PHONE_NUMBER_ID: requiredString,
  META_DISPLAY_PHONE_NUMBER: requiredString,
  META_WABA_ID: requiredString,
  META_ACCESS_TOKEN: requiredString,
});

const ENV_VARIABLES = Object.keys(configureMetaEnvSchema.shape);

/**
 * Validates the environment. Every variable must be present and non-blank
 * (values are trimmed). On failure only the variable NAMES are reported.
 */
export const parseConfigureMetaEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Result<ConfigureMetaInput, ConfigureMetaError> => {
  const parsed = configureMetaEnvSchema.safeParse(env);
  if (!parsed.success) {
    const invalid = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    return err({
      code: 'INVALID_ENV',
      variables: ENV_VARIABLES.filter((name) => invalid.has(name)),
    });
  }

  const values = parsed.data;
  return ok({
    databaseAdminUrl: values.DATABASE_ADMIN_URL,
    credentials: {
      phoneNumberId: values.META_PHONE_NUMBER_ID,
      displayPhoneNumber: values.META_DISPLAY_PHONE_NUMBER,
      wabaId: values.META_WABA_ID,
      accessToken: values.META_ACCESS_TOKEN,
    },
  });
};

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/** Partial unique index on whatsapp_accounts(phone_number_id) WHERE deleted_at IS NULL (0002). */
const PHONE_NUMBER_ID_UNIQUE_INDEX = 'whatsapp_accounts_phone_number_id_uq';
const UNIQUE_VIOLATION = '23505';

const isPhoneNumberIdConflict = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  cause.code === UNIQUE_VIOLATION &&
  'constraint_name' in cause &&
  cause.constraint_name === PHONE_NUMBER_ID_UNIQUE_INDEX;

/**
 * Upserts the dev tenant's single active WhatsApp account with the given Meta
 * credentials and makes sure it has an AI config row (switched off when created)
 * — atomically. An existing AI config is never rewritten.
 *
 * Expected failures are returned as Result errors (nothing is written). A
 * phone_number_id already owned by another live row rolls the transaction back
 * and returns PHONE_NUMBER_ID_IN_USE. Any other database error is rethrown
 * (infrastructure failure).
 *
 * @param sql         - postgres.js client on DATABASE_ADMIN_URL (privileged bootstrap handle).
 * @param credentials - Meta test-number credentials (from parseConfigureMetaEnv).
 */
export const configureMeta = async (
  sql: postgres.Sql,
  credentials: MetaCredentials,
): Promise<Result<ConfigureMetaSummary, ConfigureMetaError>> => {
  try {
    return await sql.begin((tx) => provisionDevTenant(tx, credentials));
  } catch (cause) {
    if (isPhoneNumberIdConflict(cause)) {
      return err({ code: 'PHONE_NUMBER_ID_IN_USE', phoneNumberId: credentials.phoneNumberId });
    }
    throw cause;
  }
};

const provisionDevTenant = async (
  tx: postgres.TransactionSql,
  credentials: MetaCredentials,
): Promise<Result<ConfigureMetaSummary, ConfigureMetaError>> => {
  // 1) Read (and lock) the dev tenant's live rows. All validation happens
  //    before the first write, so every error path leaves the DB untouched.
  const liveAccounts = await tx<{ id: string; is_active: boolean }[]>`
    SELECT id, is_active
    FROM whatsapp_accounts
    WHERE tenant_id = ${DEV_TENANT_ID}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  const aiConfigs = await tx<{ id: string; enabled: boolean }[]>`
    SELECT id, enabled
    FROM tenant_ai_config
    WHERE tenant_id = ${DEV_TENANT_ID}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;

  if (liveAccounts.length === 0 && aiConfigs.length === 0) {
    return err({ code: 'DEV_TENANT_NOT_SEEDED', tenantId: DEV_TENANT_ID });
  }

  const activeAccounts = liveAccounts.filter((row) => row.is_active);
  if (activeAccounts.length > 1) {
    return err({ code: 'MULTIPLE_ACTIVE_ACCOUNTS', count: activeAccounts.length });
  }
  if (aiConfigs.length > 1) {
    return err({ code: 'MULTIPLE_AI_CONFIGS', count: aiConfigs.length });
  }

  // 2) Writes.
  const account = await upsertActiveAccount(tx, activeAccounts[0]?.id ?? null, credentials);
  const aiConfig = await ensureAiConfigExists(tx, aiConfigs[0] ?? null);

  return ok({
    tenantId: DEV_TENANT_ID,
    phoneNumberId: credentials.phoneNumberId,
    displayPhoneNumber: credentials.displayPhoneNumber,
    wabaId: credentials.wabaId,
    account,
    aiConfig,
  });
};

const upsertActiveAccount = async (
  tx: postgres.TransactionSql,
  activeAccountId: string | null,
  credentials: MetaCredentials,
): Promise<ConfigureMetaSummary['account']> => {
  if (activeAccountId !== null) {
    await tx`
      UPDATE whatsapp_accounts
      SET phone_number_id = ${credentials.phoneNumberId},
          display_phone_number = ${credentials.displayPhoneNumber},
          waba_id = ${credentials.wabaId},
          access_token = ${credentials.accessToken},
          updated_at = now()
      WHERE id = ${activeAccountId}::uuid AND tenant_id = ${DEV_TENANT_ID}::uuid
    `;
    return 'updated';
  }

  await tx`
    INSERT INTO whatsapp_accounts
      (tenant_id, phone_number_id, display_phone_number, waba_id, is_active, access_token)
    VALUES
      (${DEV_TENANT_ID}::uuid,
       ${credentials.phoneNumberId},
       ${credentials.displayPhoneNumber},
       ${credentials.wabaId},
       true,
       ${credentials.accessToken})
  `;
  return 'inserted';
};

/**
 * Never switches the AI on: until SiviHub's agent takes over (E4) the Hub only sends
 * fixed replies. An existing row is left exactly as it is; a missing one gets the
 * seed-dev.ts defaults with enabled = false.
 */
const ensureAiConfigExists = async (
  tx: postgres.TransactionSql,
  existing: { id: string } | null,
): Promise<ConfigureMetaSummary['aiConfig']> => {
  if (existing !== null) {
    return 'unchanged';
  }

  // Same values seed-dev.ts uses for the dev tenant.
  await tx`
    INSERT INTO tenant_ai_config
      (tenant_id, vertical, business_name, business_info, enabled)
    VALUES
      (${DEV_TENANT_ID}::uuid,
       ${DEV_AI_VERTICAL},
       ${DEV_AI_BUSINESS_NAME},
       ${JSON.stringify(DEV_AI_BUSINESS_INFO)}::jsonb,
       false)
  `;
  return 'inserted';
};

// ---------------------------------------------------------------------------
// Output (never includes the access token)
// ---------------------------------------------------------------------------

const RUN_SEED = 'pnpm --filter @sivihub/whatsapp-hub-backend seed:dev';
const RUN_MIGRATE = 'pnpm --filter @sivihub/whatsapp-hub-backend migrate';

export const formatConfigureMetaSummary = (summary: ConfigureMetaSummary): string =>
  [
    '[configure-meta] done — dev tenant wired to the real Meta number',
    `  tenant_id:            ${summary.tenantId}`,
    `  phone_number_id:      ${summary.phoneNumberId}`,
    `  display_phone_number: ${summary.displayPhoneNumber}`,
    `  waba_id:              ${summary.wabaId}`,
    `  whatsapp_accounts:    ${summary.account}`,
    `  tenant_ai_config:     ${summary.aiConfig} (AI never switched on here; see AI_REPLY_ENABLED)`,
    '  access_token:         stored (never printed)',
  ].join('\n');

export const formatConfigureMetaError = (error: ConfigureMetaError): string => {
  switch (error.code) {
    case 'INVALID_ENV':
      return [
        `[configure-meta] missing or empty environment variable(s): ${error.variables.join(', ')}.`,
        'Set them in your .env (see Docs/runbooks/meta-test-number.md).',
        'Credentials are read from the environment only, never from CLI arguments.',
      ].join(' ');
    case 'DEV_TENANT_NOT_SEEDED':
      return [
        `[configure-meta] dev tenant ${error.tenantId} not found.`,
        `Run \`${RUN_MIGRATE}\` and then \`${RUN_SEED}\` first.`,
      ].join(' ');
    case 'MULTIPLE_ACTIVE_ACCOUNTS':
      return [
        `[configure-meta] the dev tenant has ${error.count} active whatsapp_accounts rows;`,
        'the send path requires exactly one. Soft-delete the extra rows (set deleted_at)',
        'and run again. Nothing was changed.',
      ].join(' ');
    case 'MULTIPLE_AI_CONFIGS':
      return [
        `[configure-meta] the dev tenant has ${error.count} live tenant_ai_config rows;`,
        'the AI reply requires exactly one. Soft-delete the extra rows (set deleted_at)',
        'and run again. Nothing was changed.',
      ].join(' ');
    case 'PHONE_NUMBER_ID_IN_USE':
      return [
        `[configure-meta] phone_number_id ${error.phoneNumberId} already belongs to another`,
        'whatsapp_accounts row that is not soft-deleted (another tenant or an inactive row).',
        'Nothing was changed.',
      ].join(' ');
  }
};

/** Formats an unexpected (infrastructure) error with every secret redacted. */
export const describeUnexpectedError = (cause: unknown, secrets: ReadonlyArray<string>): string => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const redacted = secrets
    .filter((secret) => secret.length > 0)
    .reduce((text, secret) => text.split(secret).join('[redacted]'), raw);
  return `[configure-meta] failed: ${redacted}`;
};

// ---------------------------------------------------------------------------
// Standalone script entrypoint
// ---------------------------------------------------------------------------

// When this module is the entry point (not imported), run the command.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url)
    .replace(/\\/g, '/')
    .endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const input = parseConfigureMetaEnv(process.env);
  if (!input.ok) {
    console.error(formatConfigureMetaError(input.error));
    process.exit(1);
  }

  const { databaseAdminUrl, credentials } = input.value;
  const sql = postgres(databaseAdminUrl, { max: 1 });
  let exitCode = 1;
  try {
    const result = await configureMeta(sql, credentials);
    if (result.ok) {
      console.info(formatConfigureMetaSummary(result.value));
      exitCode = 0;
    } else {
      console.error(formatConfigureMetaError(result.error));
    }
  } catch (cause) {
    console.error(describeUnexpectedError(cause, [credentials.accessToken, databaseAdminUrl]));
  } finally {
    await sql.end();
  }
  process.exit(exitCode);
}
