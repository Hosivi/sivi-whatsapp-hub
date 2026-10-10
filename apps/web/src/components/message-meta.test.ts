import { describe, expect, it } from 'vitest';
import type { AiUsageDTO, MessageDTO } from '../lib/api';
import {
  describeAuthor,
  formatAiTotals,
  formatAiUsage,
  resolveAuthor,
  summarizeAiUsage,
} from './message-meta';

const usage = (overrides: Partial<AiUsageDTO> = {}): AiUsageDTO => ({
  provider: 'gemini',
  model: 'gemini-3.5-flash-lite',
  inputTokens: 1200,
  outputTokens: 345,
  reasoningTokens: null,
  totalTokens: 1545,
  latencyMs: 1830,
  llmCalls: 1,
  toolCalls: [],
  fallbackCount: 0,
  ...overrides,
});

const message = (overrides: Partial<MessageDTO> = {}): MessageDTO => ({
  wamid: 'wamid.1',
  name: 'Ana Pérez',
  phone: '+51987654321',
  text: 'Hola',
  type: 'text',
  receivedAt: '2026-10-10T15:00:00.000Z',
  direction: 'inbound',
  ...overrides,
});

describe('resolveAuthor', () => {
  it('uses the author reported by the API', () => {
    expect(resolveAuthor(message({ direction: 'outbound', author: 'ai' }))).toBe('ai');
    expect(resolveAuthor(message({ direction: 'outbound', author: 'operator' }))).toBe('operator');
    expect(resolveAuthor(message({ author: 'customer' }))).toBe('customer');
  });

  it('falls back to the direction when the API omits the author', () => {
    expect(resolveAuthor(message({ direction: 'inbound' }))).toBe('customer');
    expect(resolveAuthor(message({ direction: 'outbound' }))).toBe('operator');
  });
});

describe('describeAuthor', () => {
  it('shows the customer name and phone for customer messages', () => {
    expect(describeAuthor(message({ author: 'customer' }))).toEqual({
      kind: 'customer',
      badge: 'Cliente',
      title: 'Ana Pérez',
      subtitle: '+51987654321',
      hint: 'Mensaje recibido del cliente',
    });
  });

  it('uses the phone as the title when the customer has no name', () => {
    const author = describeAuthor(message({ author: 'customer', name: null }));
    expect(author.title).toBe('+51987654321');
    expect(author.subtitle).toBeNull();
  });

  it('labels AI replies as the AI and shows the contact as the recipient', () => {
    expect(describeAuthor(message({ direction: 'outbound', author: 'ai' }))).toEqual({
      kind: 'ai',
      badge: 'IA',
      title: 'Asistente IA',
      subtitle: 'Para Ana Pérez · +51987654321',
      hint: 'Respuesta automática generada por la IA',
    });
  });

  it('labels operator sends as manual and never uses the recipient name as author', () => {
    const author = describeAuthor(message({ direction: 'outbound', author: 'operator' }));
    expect(author.kind).toBe('operator');
    expect(author.badge).toBe('Operador');
    expect(author.title).toBe('Operador · envío manual');
    expect(author.subtitle).toBe('Para Ana Pérez · +51987654321');
  });

  it('treats a legacy outbound message without author as an operator send', () => {
    const author = describeAuthor(message({ direction: 'outbound', name: null }));
    expect(author.kind).toBe('operator');
    expect(author.subtitle).toBe('Para +51987654321');
  });
});

describe('formatAiUsage', () => {
  it('formats provider, model, tokens and latency', () => {
    expect(formatAiUsage(usage())).toEqual({
      model: 'gemini · gemini-3.5-flash-lite',
      tokens: '1,545 tokens',
      breakdown: 'entrada 1,200 · salida 345',
      latency: '1.8 s',
      fallbackNote: null,
      toolsNote: null,
    });
  });

  it('includes reasoning tokens as part of the output when reported', () => {
    const view = formatAiUsage(usage({ reasoningTokens: 120 }));
    expect(view.breakdown).toBe('entrada 1,200 · salida 345 (razonamiento 120)');
  });

  it('notes model fallbacks with singular and plural copy', () => {
    expect(formatAiUsage(usage({ fallbackCount: 1 })).fallbackNote).toBe('1 salto de modelo');
    expect(formatAiUsage(usage({ fallbackCount: 2 })).fallbackNote).toBe('2 saltos de modelo');
  });

  it('notes the distinct tools used', () => {
    const view = formatAiUsage(
      usage({ toolCalls: ['check_availability', 'check_availability', 'get_price'] }),
    );
    expect(view.toolsNote).toBe('herramientas: check_availability, get_price');
  });

  it('formats an OpenAI reply', () => {
    const view = formatAiUsage(
      usage({ provider: 'openai', model: 'gpt-6-luna', totalTokens: 12345, latencyMs: 450 }),
    );
    expect(view.model).toBe('openai · gpt-6-luna');
    expect(view.tokens).toBe('12,345 tokens');
    expect(view.latency).toBe('0.5 s');
  });
});

describe('summarizeAiUsage', () => {
  it('counts AI replies and sums their tokens, ignoring other authors', () => {
    const totals = summarizeAiUsage([
      message({ author: 'customer' }),
      message({ direction: 'outbound', author: 'ai', ai: usage() }),
      message({
        direction: 'outbound',
        author: 'ai',
        ai: usage({ inputTokens: 800, outputTokens: 200, totalTokens: 1000 }),
      }),
      message({ direction: 'outbound', author: 'operator', ai: null }),
      message({ direction: 'outbound' }),
    ]);
    expect(totals).toEqual({
      aiReplies: 2,
      inputTokens: 2000,
      outputTokens: 545,
      totalTokens: 2545,
    });
  });

  it('counts an AI reply without usage data but adds no tokens', () => {
    const totals = summarizeAiUsage([message({ direction: 'outbound', author: 'ai', ai: null })]);
    expect(totals).toEqual({ aiReplies: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

describe('formatAiTotals', () => {
  it('summarizes AI replies and tokens', () => {
    expect(
      formatAiTotals({ aiReplies: 2, inputTokens: 2000, outputTokens: 545, totalTokens: 2545 }),
    ).toBe('2 respuestas de IA · 2,545 tokens (entrada 2,000 · salida 545)');
  });

  it('uses singular copy for one reply', () => {
    expect(
      formatAiTotals({ aiReplies: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    ).toBe('1 respuesta de IA · 15 tokens (entrada 10 · salida 5)');
  });

  it('says there are no AI replies when none are shown', () => {
    expect(formatAiTotals({ aiReplies: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe(
      'Sin respuestas de IA en los mensajes mostrados',
    );
  });
});
