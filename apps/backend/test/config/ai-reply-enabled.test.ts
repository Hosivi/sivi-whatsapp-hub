/**
 * ai-reply-enabled.test.ts — Unit tests for the AI_REPLY_ENABLED kill switch in loadEnv().
 * Docker-free: pure Vitest, no container needed.
 *
 * The switch is off until SiviHub's agent takes over (stage E4). Only the literal
 * string "true" turns it on; every other value (unset, "false", "1", …) keeps it off.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const VALID_ENV = {
  DATABASE_URL: 'postgresql://app_rls:pass@localhost:5432/hub',
  DATABASE_ADMIN_URL: 'postgresql://postgres:admin@localhost:5432/hub',
  AUTH_MODE: 'dev-header',
  WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost:5432/hub',
};

/** Remove a key from process.env without using delete (Biome noDelete rule). */
const unsetEnv = (key: string): void => {
  Reflect.deleteProperty(process.env, key);
};

describe('loadEnv() — AI_REPLY_ENABLED kill switch', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    Object.assign(process.env, VALID_ENV);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        unsetEnv(key);
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('is false when unset (AI replies are off by default)', () => {
    unsetEnv('AI_REPLY_ENABLED');
    expect(loadEnv().AI_REPLY_ENABLED).toBe(false);
  });

  it('is false when set to "false"', () => {
    process.env.AI_REPLY_ENABLED = 'false';
    expect(loadEnv().AI_REPLY_ENABLED).toBe(false);
  });

  it('is false when set to "1" (only the literal "true" enables it)', () => {
    process.env.AI_REPLY_ENABLED = '1';
    expect(loadEnv().AI_REPLY_ENABLED).toBe(false);
  });

  it('is true only when set to the literal "true"', () => {
    process.env.AI_REPLY_ENABLED = 'true';
    expect(loadEnv().AI_REPLY_ENABLED).toBe(true);
  });
});
