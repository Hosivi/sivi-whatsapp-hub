/**
 * system-prompt.unit.test.ts — Unit tests for buildTiendaGeneralSystemPrompt.
 *
 * Strict TDD: written RED before implementation.
 *
 * Invariants verified:
 * - Generated prompt contains business_name.
 * - Generated prompt contains all four tienda_general intent labels.
 * - systemPromptOverride replaces the generated prompt verbatim.
 * - Customer text NEVER appears in the system prompt (injection guard D8).
 */

import { describe, expect, it } from 'vitest';
import { buildTiendaGeneralSystemPrompt } from '../../src/ai/system-prompt.js';
import type { TenantAiConfig } from '../../src/db/schema/tenant-ai-config.schema.js';

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeConfig(overrides: Partial<TenantAiConfig> = {}): TenantAiConfig {
  return {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    tenantId: TENANT_ID,
    vertical: 'tienda_general',
    businessName: 'Tienda La Esperanza',
    businessInfo: { address: 'Av. Lima 123' },
    enabled: true,
    systemPromptOverride: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildTiendaGeneralSystemPrompt', () => {
  it('(a) generated prompt contains the business name', () => {
    const prompt = buildTiendaGeneralSystemPrompt(makeConfig());
    expect(prompt).toContain('Tienda La Esperanza');
  });

  it('(b) generated prompt contains all four tienda_general intent labels', () => {
    const prompt = buildTiendaGeneralSystemPrompt(makeConfig());
    // All four tienda_general intents must appear (human-readable labels)
    expect(prompt).toContain('ver catálogo');
    expect(prompt).toContain('hacer pedido');
    expect(prompt).toContain('consultar precio');
    expect(prompt).toContain('estado de pedido');
  });

  it('(c) systemPromptOverride returns the override verbatim', () => {
    const override = 'Custom system prompt for this tenant only.';
    const config = makeConfig({ systemPromptOverride: override });
    const prompt = buildTiendaGeneralSystemPrompt(config);
    expect(prompt).toBe(override);
  });

  it('(d) override replaces the generated prompt entirely (no mixing)', () => {
    const override = 'Only this text.';
    const config = makeConfig({
      businessName: 'Should Not Appear',
      systemPromptOverride: override,
    });
    const prompt = buildTiendaGeneralSystemPrompt(config);
    expect(prompt).toBe(override);
    expect(prompt).not.toContain('Should Not Appear');
  });

  it('(e) customer text is never injected into the generated prompt (D8 injection guard)', () => {
    // Even if businessName somehow contained "attacker payload", it is the
    // business name field (operator input), not customer text.
    // Customer text belongs in role='user' messages, never in the system prompt.
    // This test verifies there are no template holes that would inject dynamic
    // customer content into the system turn.
    const config = makeConfig({ businessName: 'Tienda XYZ' });
    const prompt = buildTiendaGeneralSystemPrompt(config);
    // Prompt must not contain any placeholder that would interpolate customer messages
    expect(prompt).not.toContain('{customer_message}');
    expect(prompt).not.toContain('{user_input}');
    expect(prompt).not.toContain('{text}');
    // The generated prompt must be a static template with only operator-supplied values
    expect(prompt).toContain('Tienda XYZ'); // business name is operator input — ok
  });

  it('(f) null override → generates prompt (not null/undefined)', () => {
    const config = makeConfig({ systemPromptOverride: null });
    const prompt = buildTiendaGeneralSystemPrompt(config);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(50);
  });
});
