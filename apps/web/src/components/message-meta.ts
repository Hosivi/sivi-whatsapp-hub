/**
 * message-meta.ts — pure presentation helpers for Hub messages: who authored a
 * message and how much an AI reply cost in tokens. Kept free of React so the
 * derivations are unit-testable.
 *
 * On outbound rows `name`/`phone` describe the RECIPIENT (the contact), so the
 * author is always derived from `author` (or `direction` on older backends),
 * never from `name`.
 */

import type { AiUsageDTO, MessageAuthor, MessageDTO } from '../lib/api';

const LOCALE = 'es-PE';
const countFormat = new Intl.NumberFormat(LOCALE);
const secondsFormat = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export interface AuthorDescription {
  kind: MessageAuthor;
  /** Short visible badge text — the non-color signal of the author. */
  badge: string;
  /** Primary line: who wrote the message. */
  title: string;
  /** Secondary line: customer phone, or the recipient for outbound rows. */
  subtitle: string | null;
  /** Longer description for tooltips / assistive tech. */
  hint: string;
}

export interface AiUsageView {
  model: string;
  tokens: string;
  breakdown: string;
  latency: string;
  fallbackNote: string | null;
  toolsNote: string | null;
}

export interface AiUsageTotals {
  aiReplies: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function formatCount(value: number): string {
  return countFormat.format(value);
}

/** Author reported by the API; legacy rows without it fall back to the direction. */
export function resolveAuthor(message: Pick<MessageDTO, 'author' | 'direction'>): MessageAuthor {
  if (message.author === 'customer' || message.author === 'ai' || message.author === 'operator') {
    return message.author;
  }
  return message.direction === 'outbound' ? 'operator' : 'customer';
}

export function describeAuthor(
  message: Pick<MessageDTO, 'author' | 'direction' | 'name' | 'phone'>,
): AuthorDescription {
  const kind = resolveAuthor(message);
  const name = message.name?.trim() || null;

  if (kind === 'customer') {
    return {
      kind,
      badge: 'Cliente',
      title: name ?? message.phone,
      subtitle: name ? message.phone : null,
      hint: 'Mensaje recibido del cliente',
    };
  }

  const recipient = `Para ${name ? `${name} · ${message.phone}` : message.phone}`;

  if (kind === 'ai') {
    return {
      kind,
      badge: 'IA',
      title: 'Asistente IA',
      subtitle: recipient,
      hint: 'Respuesta automática generada por la IA',
    };
  }

  return {
    kind,
    badge: 'Operador',
    title: 'Operador · envío manual',
    subtitle: recipient,
    hint: 'Mensaje enviado manualmente por un operador',
  };
}

export function formatAiUsage(ai: AiUsageDTO): AiUsageView {
  // Reasoning tokens are a subset of the output tokens, not an extra bucket.
  const output =
    ai.reasoningTokens !== null && ai.reasoningTokens !== undefined
      ? `salida ${formatCount(ai.outputTokens)} (razonamiento ${formatCount(ai.reasoningTokens)})`
      : `salida ${formatCount(ai.outputTokens)}`;

  const fallbackCount = ai.fallbackCount ?? 0;
  const tools = [...new Set(Array.isArray(ai.toolCalls) ? ai.toolCalls : [])];

  return {
    model: `${ai.provider} · ${ai.model}`,
    tokens: `${formatCount(ai.totalTokens)} tokens`,
    breakdown: `entrada ${formatCount(ai.inputTokens)} · ${output}`,
    latency: `${secondsFormat.format(ai.latencyMs / 1000)} s`,
    fallbackNote:
      fallbackCount > 0
        ? `${fallbackCount} ${fallbackCount === 1 ? 'salto' : 'saltos'} de modelo`
        : null,
    toolsNote: tools.length > 0 ? `herramientas: ${tools.join(', ')}` : null,
  };
}

/** Counts AI replies among the given messages and sums their reported tokens. */
export function summarizeAiUsage(
  messages: ReadonlyArray<Pick<MessageDTO, 'author' | 'direction' | 'ai'>>,
): AiUsageTotals {
  return messages.reduce<AiUsageTotals>(
    (totals, message) => {
      if (resolveAuthor(message) !== 'ai') return totals;
      const ai = message.ai;
      return {
        aiReplies: totals.aiReplies + 1,
        inputTokens: totals.inputTokens + (ai?.inputTokens ?? 0),
        outputTokens: totals.outputTokens + (ai?.outputTokens ?? 0),
        totalTokens: totals.totalTokens + (ai?.totalTokens ?? 0),
      };
    },
    { aiReplies: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

export function formatAiTotals(totals: AiUsageTotals): string {
  if (totals.aiReplies === 0) return 'Sin respuestas de IA en los mensajes mostrados';
  const replies = `${totals.aiReplies} ${totals.aiReplies === 1 ? 'respuesta' : 'respuestas'} de IA`;
  return (
    `${replies} · ${formatCount(totals.totalTokens)} tokens ` +
    `(entrada ${formatCount(totals.inputTokens)} · salida ${formatCount(totals.outputTokens)})`
  );
}
