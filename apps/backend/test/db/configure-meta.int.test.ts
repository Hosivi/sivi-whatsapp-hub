/**
 * configure-meta.int.test.ts — Tests for the `configure:meta` provisioning command.
 *
 * Pure tests (env parsing, output formatting) run without a database.
 * DB tests use Testcontainers (PG16) via createTestDb and the admin (superuser)
 * handle, exactly like seed-dev.test.ts — configure:meta is a bootstrap script
 * that runs on DATABASE_ADMIN_URL.
 *
 * Covered:
 * - missing/blank env → INVALID_ENV naming the variables, never echoing values
 * - DEV tenant not seeded → DEV_TENANT_NOT_SEEDED
 * - update path (seeded dev account replaced by the real credentials)
 * - insert path (no active account → one inserted)
 * - >1 active accounts → MULTIPLE_ACTIVE_ACCOUNTS, nothing written
 * - tenant_ai_config never switched on (existing row untouched / seed defaults inserted off)
 * - phone_number_id owned by another tenant → PHONE_NUMBER_ID_IN_USE, tx rolled back
 * - the access token never appears in any produced output string
 *
 * TDD — written RED before configure-meta.ts existed.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTenantAiConfig } from '../../src/ai/tenant-ai-config.repository.js';
import {
  type ConfigureMetaError,
  type MetaCredentials,
  configureMeta,
  describeUnexpectedError,
  formatConfigureMetaError,
  formatConfigureMetaSummary,
  parseConfigureMetaEnv,
} from '../../src/db/configure-meta.js';
import { tenantAiConfigTable } from '../../src/db/schema/tenant-ai-config.schema.js';
import { whatsappAccountsTable } from '../../src/db/schema/whatsapp-accounts.schema.js';
import {
  DEV_AI_BUSINESS_NAME,
  DEV_AI_VERTICAL,
  DEV_PHONE_NUMBER_ID,
  DEV_TENANT_ID,
  runDevSeed,
} from '../../src/db/seed-dev.js';
import { resolveActiveAccount } from '../../src/whatsapp-send/whatsapp-send.service.js';
import type { TestDb } from '../_helpers/test-db.js';
import { createTestDb } from '../_helpers/test-db.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET_TOKEN = 'EAAG-super-secret-token-value-1234567890';
const ADMIN_URL = 'postgresql://postgres:admin-secret-pw@localhost:5434/sivi_whatsapp_hub';

const CREDENTIALS: MetaCredentials = {
  phoneNumberId: '109876543210987',
  displayPhoneNumber: '+1 555 012 3456',
  wabaId: '123456789012345',
  accessToken: SECRET_TOKEN,
};

const FULL_ENV = {
  DATABASE_ADMIN_URL: ADMIN_URL,
  META_PHONE_NUMBER_ID: CREDENTIALS.phoneNumberId,
  META_DISPLAY_PHONE_NUMBER: CREDENTIALS.displayPhoneNumber,
  META_WABA_ID: CREDENTIALS.wabaId,
  META_ACCESS_TOKEN: SECRET_TOKEN,
} as const;

const OTHER_TENANT_ID = '00000000-0000-0000-0000-0000000000ff';

const ALL_ERRORS: ReadonlyArray<ConfigureMetaError> = [
  { code: 'INVALID_ENV', variables: ['META_ACCESS_TOKEN', 'META_WABA_ID'] },
  { code: 'DEV_TENANT_NOT_SEEDED', tenantId: DEV_TENANT_ID },
  { code: 'MULTIPLE_ACTIVE_ACCOUNTS', count: 2 },
  { code: 'MULTIPLE_AI_CONFIGS', count: 2 },
  { code: 'PHONE_NUMBER_ID_IN_USE', phoneNumberId: CREDENTIALS.phoneNumberId },
];

// ---------------------------------------------------------------------------
// Pure tests — no database
// ---------------------------------------------------------------------------

describe('parseConfigureMetaEnv', () => {
  it('returns the admin URL and credentials when every variable is set', () => {
    const result = parseConfigureMetaEnv(FULL_ENV);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.databaseAdminUrl).toBe(ADMIN_URL);
    expect(result.value.credentials).toEqual(CREDENTIALS);
  });

  it('trims surrounding whitespace (copy/paste of a token with a trailing newline)', () => {
    const result = parseConfigureMetaEnv({ ...FULL_ENV, META_ACCESS_TOKEN: `  ${SECRET_TOKEN}\n` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credentials.accessToken).toBe(SECRET_TOKEN);
  });

  it('fails with INVALID_ENV naming every missing variable', () => {
    const result = parseConfigureMetaEnv({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: 'INVALID_ENV',
      variables: [
        'DATABASE_ADMIN_URL',
        'META_PHONE_NUMBER_ID',
        'META_DISPLAY_PHONE_NUMBER',
        'META_WABA_ID',
        'META_ACCESS_TOKEN',
      ],
    });
  });

  it('treats empty and whitespace-only values as missing', () => {
    const result = parseConfigureMetaEnv({
      ...FULL_ENV,
      META_WABA_ID: '',
      META_ACCESS_TOKEN: '  ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: 'INVALID_ENV',
      variables: ['META_WABA_ID', 'META_ACCESS_TOKEN'],
    });
  });

  it('never echoes provided values in the error or its message', () => {
    const { META_WABA_ID: _omitted, ...withoutWaba } = FULL_ENV;
    const result = parseConfigureMetaEnv(withoutWaba);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = formatConfigureMetaError(result.error);
    expect(message).toContain('META_WABA_ID');
    for (const output of [message, JSON.stringify(result)]) {
      expect(output).not.toContain(SECRET_TOKEN);
      expect(output).not.toContain(ADMIN_URL);
      expect(output).not.toContain('admin-secret-pw');
    }
  });
});

describe('configure-meta output strings', () => {
  it('summary includes tenant, phone_number_id and display number but never the token', () => {
    const text = formatConfigureMetaSummary({
      tenantId: DEV_TENANT_ID,
      phoneNumberId: CREDENTIALS.phoneNumberId,
      displayPhoneNumber: CREDENTIALS.displayPhoneNumber,
      wabaId: CREDENTIALS.wabaId,
      account: 'updated',
      aiConfig: 'unchanged',
    });

    expect(text).toContain(DEV_TENANT_ID);
    expect(text).not.toContain('enabled = true');
    expect(text).toContain(CREDENTIALS.phoneNumberId);
    expect(text).toContain(CREDENTIALS.displayPhoneNumber);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SECRET_TOKEN.slice(0, 8));
  });

  it('every error message is non-empty, actionable and token-free', () => {
    for (const error of ALL_ERRORS) {
      const text = formatConfigureMetaError(error);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(SECRET_TOKEN);
    }
    expect(
      formatConfigureMetaError({ code: 'DEV_TENANT_NOT_SEEDED', tenantId: DEV_TENANT_ID }),
    ).toContain('pnpm --filter @sivihub/whatsapp-hub-backend seed:dev');
  });

  it('describeUnexpectedError redacts every secret from the underlying message', () => {
    const cause = new Error(`boom: token=${SECRET_TOKEN} url=${ADMIN_URL}`);
    const text = describeUnexpectedError(cause, [SECRET_TOKEN, ADMIN_URL]);

    expect(text).toContain('boom');
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(ADMIN_URL);
    expect(describeUnexpectedError('plain string failure', [SECRET_TOKEN])).toContain(
      'plain string failure',
    );
  });
});

// ---------------------------------------------------------------------------
// DB tests — Testcontainers
// ---------------------------------------------------------------------------

describe('configureMeta (Testcontainers)', () => {
  let db: TestDb;

  const activeDevAccounts = () =>
    db.adminQuery((tx) =>
      tx
        .select()
        .from(whatsappAccountsTable)
        .where(
          and(
            eq(whatsappAccountsTable.tenantId, DEV_TENANT_ID),
            eq(whatsappAccountsTable.isActive, true),
            isNull(whatsappAccountsTable.deletedAt),
          ),
        ),
    );

  const devAiConfigs = () =>
    db.adminQuery((tx) =>
      tx
        .select()
        .from(tenantAiConfigTable)
        .where(
          and(
            eq(tenantAiConfigTable.tenantId, DEV_TENANT_ID),
            isNull(tenantAiConfigTable.deletedAt),
          ),
        ),
    );

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.teardown();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it('fails with DEV_TENANT_NOT_SEEDED when seed:dev never ran', async () => {
    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result).toEqual({
      ok: false,
      error: { code: 'DEV_TENANT_NOT_SEEDED', tenantId: DEV_TENANT_ID },
    });
    expect(await activeDevAccounts()).toHaveLength(0);
  });

  it('update path: replaces the seeded dev account with the real Meta credentials', async () => {
    await runDevSeed(db.adminSql);
    // Backdate updated_at so the bump is observable deterministically.
    await db.adminSql`UPDATE whatsapp_accounts SET updated_at = '2000-01-01T00:00:00Z' WHERE tenant_id = ${DEV_TENANT_ID}::uuid`;
    const [before] = await activeDevAccounts();

    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      tenantId: DEV_TENANT_ID,
      phoneNumberId: CREDENTIALS.phoneNumberId,
      displayPhoneNumber: CREDENTIALS.displayPhoneNumber,
      wabaId: CREDENTIALS.wabaId,
      account: 'updated',
      aiConfig: 'unchanged',
    });
    // configure:meta never switches the AI on: the seeded config stays off.
    expect((await devAiConfigs())[0]?.enabled).toBe(false);

    const rows = await activeDevAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before?.id);
    expect(rows[0]?.phoneNumberId).toBe(CREDENTIALS.phoneNumberId);
    expect(rows[0]?.displayPhoneNumber).toBe(CREDENTIALS.displayPhoneNumber);
    expect(rows[0]?.wabaId).toBe(CREDENTIALS.wabaId);
    expect(rows[0]?.accessToken).toBe(SECRET_TOKEN);
    expect(rows[0]?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);

    // The real runtime paths now see the new account.
    expect(await db.resolveTenant(CREDENTIALS.phoneNumberId)).toEqual({
      ok: true,
      value: DEV_TENANT_ID,
    });
    expect(await db.resolveTenant(DEV_PHONE_NUMBER_ID)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_PHONE_NUMBER_ID' },
    });
    expect(await resolveActiveAccount(db.withTenant, DEV_TENANT_ID)).toEqual({
      ok: true,
      value: { phoneNumberId: CREDENTIALS.phoneNumberId, accessToken: SECRET_TOKEN },
    });
  });

  it('is idempotent: a second run updates the same single row', async () => {
    await runDevSeed(db.adminSql);
    await configureMeta(db.adminSql, CREDENTIALS);

    const result = await configureMeta(db.adminSql, {
      ...CREDENTIALS,
      accessToken: 'rotated-token',
    });

    expect(result.ok).toBe(true);
    const rows = await activeDevAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accessToken).toBe('rotated-token');
  });

  it('insert path: creates the account when the tenant has no active account', async () => {
    await runDevSeed(db.adminSql);
    await db.adminSql`UPDATE whatsapp_accounts SET deleted_at = now() WHERE tenant_id = ${DEV_TENANT_ID}::uuid`;

    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.account).toBe('inserted');
    const rows = await activeDevAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phoneNumberId).toBe(CREDENTIALS.phoneNumberId);
    expect(rows[0]?.accessToken).toBe(SECRET_TOKEN);
  });

  it('fails with MULTIPLE_ACTIVE_ACCOUNTS and writes nothing when >1 active accounts exist', async () => {
    await runDevSeed(db.adminSql);
    await db.seedWhatsappAccount({
      tenantId: DEV_TENANT_ID,
      phoneNumberId: 'second-dev-phone',
      displayPhoneNumber: '+51999999999',
      wabaId: 'second-waba',
      accessToken: 'second-token',
    });
    await db.adminSql`UPDATE tenant_ai_config SET enabled = false WHERE tenant_id = ${DEV_TENANT_ID}::uuid`;

    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result).toEqual({ ok: false, error: { code: 'MULTIPLE_ACTIVE_ACCOUNTS', count: 2 } });
    const rows = await activeDevAccounts();
    expect(rows.map((r) => r.accessToken)).not.toContain(SECRET_TOKEN);
    expect((await devAiConfigs())[0]?.enabled).toBe(false);
  });

  it('never switches the AI on: an existing disabled AI config stays disabled and untouched', async () => {
    await runDevSeed(db.adminSql);
    await db.adminSql`UPDATE tenant_ai_config SET enabled = false WHERE tenant_id = ${DEV_TENANT_ID}::uuid`;
    const [before] = await devAiConfigs();

    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aiConfig).toBe('unchanged');
    const configs = await devAiConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0]).toEqual(before);

    // The AI reply path (RLS-scoped) still sees no enabled config.
    const runtime = await getTenantAiConfig(db.withTenant, DEV_TENANT_ID);
    expect(runtime).toEqual({ ok: true, value: null });
  });

  it('leaves an existing enabled AI config untouched (existing rows are not rewritten)', async () => {
    await runDevSeed(db.adminSql);
    await db.adminSql`UPDATE tenant_ai_config SET enabled = true WHERE tenant_id = ${DEV_TENANT_ID}::uuid`;
    const [before] = await devAiConfigs();

    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aiConfig).toBe('unchanged');
    expect(await devAiConfigs()).toEqual([before]);
  });

  it('inserts the seed-default AI config, switched off, when the tenant has none', async () => {
    await runDevSeed(db.adminSql);
    await db.adminSql`DELETE FROM tenant_ai_config WHERE tenant_id = ${DEV_TENANT_ID}::uuid`;

    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aiConfig).toBe('inserted');
    const configs = await devAiConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0]?.enabled).toBe(false);
    expect(configs[0]?.vertical).toBe(DEV_AI_VERTICAL);
    expect(configs[0]?.businessName).toBe(DEV_AI_BUSINESS_NAME);
  });

  it('fails with MULTIPLE_AI_CONFIGS when the tenant has >1 live AI configs', async () => {
    await runDevSeed(db.adminSql);
    await db.adminSql`
      INSERT INTO tenant_ai_config (tenant_id, vertical, business_name, business_info, enabled)
      VALUES (${DEV_TENANT_ID}::uuid, 'otro', 'Otra', '{}'::jsonb, false)
    `;

    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result).toEqual({ ok: false, error: { code: 'MULTIPLE_AI_CONFIGS', count: 2 } });
    expect((await activeDevAccounts())[0]?.phoneNumberId).toBe(DEV_PHONE_NUMBER_ID);
  });

  it('fails with PHONE_NUMBER_ID_IN_USE and rolls back when another tenant owns the number', async () => {
    await runDevSeed(db.adminSql);
    await db.adminSql`UPDATE tenant_ai_config SET enabled = false WHERE tenant_id = ${DEV_TENANT_ID}::uuid`;
    await db.seedWhatsappAccount({
      tenantId: OTHER_TENANT_ID,
      phoneNumberId: CREDENTIALS.phoneNumberId,
      displayPhoneNumber: '+51988888888',
      wabaId: 'other-waba',
    });

    const result = await configureMeta(db.adminSql, CREDENTIALS);

    expect(result).toEqual({
      ok: false,
      error: { code: 'PHONE_NUMBER_ID_IN_USE', phoneNumberId: CREDENTIALS.phoneNumberId },
    });
    const rows = await activeDevAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phoneNumberId).toBe(DEV_PHONE_NUMBER_ID);
    expect(rows[0]?.accessToken).not.toBe(SECRET_TOKEN);
    expect((await devAiConfigs())[0]?.enabled).toBe(false);
  });

  it('never exposes the token in the result or in any produced output string', async () => {
    await runDevSeed(db.adminSql);

    const success = await configureMeta(db.adminSql, CREDENTIALS);
    expect(success.ok).toBe(true);
    if (!success.ok) return;
    expect(JSON.stringify(success)).not.toContain(SECRET_TOKEN);
    expect(formatConfigureMetaSummary(success.value)).not.toContain(SECRET_TOKEN);

    await db.seedWhatsappAccount({
      tenantId: DEV_TENANT_ID,
      phoneNumberId: 'extra-phone',
      displayPhoneNumber: '+51977777777',
      wabaId: 'extra-waba',
    });
    const failure = await configureMeta(db.adminSql, CREDENTIALS);
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(JSON.stringify(failure)).not.toContain(SECRET_TOKEN);
    expect(formatConfigureMetaError(failure.error)).not.toContain(SECRET_TOKEN);
  });
});
