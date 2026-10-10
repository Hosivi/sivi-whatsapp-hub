/**
 * env-ai-models.test.ts — loadEnv() parsing of the LLM settings:
 * AI_MODEL as an ordered, comma-separated model fallback chain (exposed as
 * AI_MODELS) and the optional per-attempt AI_TIMEOUT_MS.
 * Docker-free: pure Vitest, no container needed.
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

describe('loadEnv() — AI_MODEL fallback chain and AI_TIMEOUT_MS', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    Object.assign(process.env, VALID_ENV);
    unsetEnv('AI_MODEL');
    unsetEnv('AI_TIMEOUT_MS');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        unsetEnv(key);
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('defaults to the gemini-3.5 flash-lite → flash chain (2.5 is retired for new keys)', () => {
    const env = loadEnv();
    expect(env.AI_MODELS).toEqual(['gemini-3.5-flash-lite', 'gemini-3.5-flash']);
    expect(env.AI_MODEL).toBe('gemini-3.5-flash-lite,gemini-3.5-flash');
  });

  it('a single model keeps working as a one-element chain', () => {
    process.env.AI_MODEL = 'gemini-3.5-flash';
    const env = loadEnv();
    expect(env.AI_MODELS).toEqual(['gemini-3.5-flash']);
    expect(env.AI_MODEL).toBe('gemini-3.5-flash');
  });

  it('a comma-separated list keeps its order and trims spaces around entries', () => {
    process.env.AI_MODEL = '  gemini-3.5-flash-lite , gemini-3.5-flash ,gemini-3.8-flash  ';
    const env = loadEnv();
    expect(env.AI_MODELS).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.8-flash',
    ]);
  });

  it('drops empty entries (doubled, leading or trailing commas)', () => {
    process.env.AI_MODEL = ',gemini-3.5-flash-lite,, ,gemini-3.5-flash,';
    const env = loadEnv();
    expect(env.AI_MODELS).toEqual(['gemini-3.5-flash-lite', 'gemini-3.5-flash']);
  });

  it.each([[''], ['   '], [' , ,']])('throws when AI_MODEL=%j lists no model', (value) => {
    process.env.AI_MODEL = value;
    expect(() => loadEnv()).toThrow();
  });

  it('AI_TIMEOUT_MS defaults to 20000 ms', () => {
    expect(loadEnv().AI_TIMEOUT_MS).toBe(20_000);
  });

  it('AI_TIMEOUT_MS accepts a positive integer', () => {
    process.env.AI_TIMEOUT_MS = '15000';
    expect(loadEnv().AI_TIMEOUT_MS).toBe(15_000);
  });

  it.each([['0'], ['-5'], ['1.5'], ['abc']])('throws when AI_TIMEOUT_MS=%j', (value) => {
    process.env.AI_TIMEOUT_MS = value;
    expect(() => loadEnv()).toThrow();
  });
});

describe('loadEnv() — AI_MODEL provider prefixes and OPENAI_API_KEY', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    Object.assign(process.env, VALID_ENV);
    unsetEnv('AI_MODEL');
    unsetEnv('AI_TIMEOUT_MS');
    unsetEnv('OPENAI_API_KEY');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        unsetEnv(key);
      }
    }
    Object.assign(process.env, originalEnv);
  });

  /** Runs loadEnv() expecting a throw and returns the error message. */
  const loadEnvError = (): string => {
    try {
      loadEnv();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected loadEnv() to throw');
  };

  it('unprefixed entries mean gemini (T4 back-compat), including the default chain', () => {
    const env = loadEnv();
    expect(env.AI_MODEL_ENTRIES).toEqual([
      { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      { provider: 'gemini', model: 'gemini-3.5-flash' },
    ]);
  });

  it('parses a mixed ordered chain; AI_MODELS keeps the raw entries', () => {
    process.env.AI_MODEL = 'gemini-3.5-flash-lite,openai:gpt-6-luna,gemini-3.5-flash';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const env = loadEnv();
    expect(env.AI_MODEL_ENTRIES).toEqual([
      { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      { provider: 'openai', model: 'gpt-6-luna' },
      { provider: 'gemini', model: 'gemini-3.5-flash' },
    ]);
    expect(env.AI_MODELS).toEqual([
      'gemini-3.5-flash-lite',
      'openai:gpt-6-luna',
      'gemini-3.5-flash',
    ]);
  });

  it('accepts an explicit gemini: prefix, a case-insensitive prefix and spaces around it', () => {
    process.env.AI_MODEL = ' gemini: gemini-3.5-flash , OpenAI : gpt-6-luna ';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    expect(loadEnv().AI_MODEL_ENTRIES).toEqual([
      { provider: 'gemini', model: 'gemini-3.5-flash' },
      { provider: 'openai', model: 'gpt-6-luna' },
    ]);
  });

  it('keeps colons after the prefix as part of the model id (fine-tuned OpenAI ids)', () => {
    process.env.AI_MODEL = 'openai:ft:gpt-6-luna:acme::abc123';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    expect(loadEnv().AI_MODEL_ENTRIES).toEqual([
      { provider: 'openai', model: 'ft:gpt-6-luna:acme::abc123' },
    ]);
  });

  it.each([['anthropic:claude-haiku-4-5'], ['gpt:gpt-6-luna'], ['gemini-3.5-flash,mistral:large']])(
    'throws a validation error naming the unknown provider prefix for AI_MODEL=%j',
    (value) => {
      process.env.AI_MODEL = value;
      expect(loadEnvError()).toMatch(/unknown provider prefix/);
    },
  );

  it.each([['openai:'], ['gemini-3.5-flash, openai:  ']])(
    'throws when an entry has a prefix but no model (AI_MODEL=%j)',
    (value) => {
      process.env.AI_MODEL = value;
      process.env.OPENAI_API_KEY = 'sk-test-key';
      expect(loadEnvError()).toMatch(/no model/);
    },
  );

  it.each([[undefined], [''], ['   ']])(
    'fails fast naming OPENAI_API_KEY when an openai: entry is configured and the key is %j',
    (key) => {
      process.env.AI_MODEL = 'gemini-3.5-flash-lite,openai:gpt-6-luna';
      if (key !== undefined) process.env.OPENAI_API_KEY = key;
      expect(loadEnvError()).toMatch(/OPENAI_API_KEY is required/);
    },
  );

  it('OPENAI_API_KEY stays optional when no openai: entry is configured', () => {
    process.env.AI_MODEL = 'gemini-3.5-flash-lite,gemini-3.5-flash';
    const env = loadEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AI_MODEL_ENTRIES.every((entry) => entry.provider === 'gemini')).toBe(true);
  });

  it('validation errors never echo the OPENAI_API_KEY value', () => {
    process.env.AI_MODEL = 'anthropic:claude,openai:gpt-6-luna';
    process.env.OPENAI_API_KEY = 'sk-SECRET-SENTINEL-123';
    expect(loadEnvError()).not.toContain('sk-SECRET-SENTINEL-123');
  });
});
