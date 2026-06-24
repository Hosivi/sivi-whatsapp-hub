/**
 * env.test.ts — Unit tests for loadEnv() fail-fast config validation.
 * Docker-free: pure Vitest, no container needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const VALID_ENV = {
  DATABASE_URL: 'postgresql://app_rls:pass@localhost:5432/hub',
  DATABASE_ADMIN_URL: 'postgresql://postgres:admin@localhost:5432/hub',
  AUTH_MODE: 'dev-header',
  PORT: '3001',
  LOG_LEVEL: 'info',
  WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:testpassword@localhost:5432/hub',
};

/** Remove a key from process.env without using delete (Biome noDelete rule). */
const unsetEnv = (key: string): void => {
  Reflect.deleteProperty(process.env, key);
};

describe('loadEnv()', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original env — remove any keys added during the test, then restore originals.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        unsetEnv(key);
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('throws when DATABASE_URL is missing', () => {
    Object.assign(process.env, VALID_ENV);
    unsetEnv('DATABASE_URL');
    expect(() => loadEnv()).toThrow();
  });

  it('throws when DATABASE_ADMIN_URL is missing', () => {
    Object.assign(process.env, VALID_ENV);
    unsetEnv('DATABASE_ADMIN_URL');
    expect(() => loadEnv()).toThrow();
  });

  it('throws when AUTH_MODE is an invalid value', () => {
    Object.assign(process.env, VALID_ENV);
    process.env.AUTH_MODE = 'magic-link';
    expect(() => loadEnv()).toThrow();
  });

  it('accepts AUTH_MODE="dev-header"', () => {
    Object.assign(process.env, VALID_ENV);
    process.env.AUTH_MODE = 'dev-header';
    const env = loadEnv();
    expect(env.AUTH_MODE).toBe('dev-header');
  });

  it('accepts AUTH_MODE="jwt"', () => {
    Object.assign(process.env, VALID_ENV);
    process.env.AUTH_MODE = 'jwt';
    const env = loadEnv();
    expect(env.AUTH_MODE).toBe('jwt');
  });

  it('defaults PORT to 3001 when not set', () => {
    Object.assign(process.env, VALID_ENV);
    unsetEnv('PORT');
    const env = loadEnv();
    expect(env.PORT).toBe(3001);
  });

  it('parses PORT as a number', () => {
    Object.assign(process.env, VALID_ENV);
    process.env.PORT = '4000';
    const env = loadEnv();
    expect(env.PORT).toBe(4000);
  });

  it('defaults LOG_LEVEL to "info" when not set', () => {
    Object.assign(process.env, VALID_ENV);
    unsetEnv('LOG_LEVEL');
    const env = loadEnv();
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('returns all parsed fields when env is complete and valid', () => {
    Object.assign(process.env, VALID_ENV);
    const env = loadEnv();
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(env.DATABASE_ADMIN_URL).toBe(VALID_ENV.DATABASE_ADMIN_URL);
    expect(env.AUTH_MODE).toBe('dev-header');
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.WHATSAPP_VERIFY_TOKEN).toBe('test-verify-token');
    expect(env.WHATSAPP_APP_SECRET).toBe('test-app-secret');
    expect(env.DATABASE_WEBHOOK_URL).toBe(VALID_ENV.DATABASE_WEBHOOK_URL);
  });

  it('throws when WHATSAPP_VERIFY_TOKEN is missing', () => {
    Object.assign(process.env, VALID_ENV);
    unsetEnv('WHATSAPP_VERIFY_TOKEN');
    expect(() => loadEnv()).toThrow();
  });

  it('throws when WHATSAPP_APP_SECRET is missing', () => {
    Object.assign(process.env, VALID_ENV);
    unsetEnv('WHATSAPP_APP_SECRET');
    expect(() => loadEnv()).toThrow();
  });

  it('throws when DATABASE_WEBHOOK_URL is missing', () => {
    Object.assign(process.env, VALID_ENV);
    unsetEnv('DATABASE_WEBHOOK_URL');
    expect(() => loadEnv()).toThrow();
  });

  it('APP_WEBHOOK_PASSWORD is optional — does not throw when absent', () => {
    Object.assign(process.env, VALID_ENV);
    unsetEnv('APP_WEBHOOK_PASSWORD');
    const env = loadEnv();
    expect(env.APP_WEBHOOK_PASSWORD).toBeUndefined();
  });
});
