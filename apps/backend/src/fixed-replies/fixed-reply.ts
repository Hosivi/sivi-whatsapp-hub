/**
 * fixed-reply.ts — Pure selection and rendering of the fixed replies.
 *
 * Until SiviHub's agent takes over (E4) the Hub answers end customers ONLY with these
 * fixed replies (owner decision D13), never with AI-generated text:
 * - greeting: the first inbound text from a contact in the last 24 h, with a numbered menu;
 * - hours:    "1", or an hours keyword;
 * - handoff:  "2", or an advisor keyword.
 * Anything else gets no reply, so the Hub never answers every message.
 *
 * No I/O here: the service (fixed-reply.service.ts) loads the settings and the 24 h
 * history, then calls selectFixedReply and renderFixedReply.
 */

export type FixedReplyKind = 'greeting' | 'hours' | 'handoff';

export type SelectFixedReplyInput = {
  readonly text: string;
  /** true when the contact sent no other inbound text in the last 24 h. */
  readonly isFirstInboundInWindow: boolean;
};

/** Per-tenant values and override templates. Absent, null or blank means "not set". */
export type FixedReplySettings = {
  /** Value of the {negocio} placeholder. */
  readonly businessName?: string | null;
  /** Value of the {horario} placeholder. */
  readonly hoursText?: string | null;
  /** Override template for the greeting ({negocio}, {horario}). */
  readonly greetingText?: string | null;
  /** Override template for the handoff ({negocio}, {horario}). */
  readonly handoffText?: string | null;
};

// ---------------------------------------------------------------------------
// Default customer-facing texts (neutral Peruvian Spanish, tuteo)
// ---------------------------------------------------------------------------

export const DEFAULT_GREETING =
  '¡Hola! Gracias por escribir a {negocio}. Responde 1 para ver nuestro horario o 2 para hablar con un asesor.';
export const DEFAULT_GREETING_WITHOUT_NAME =
  '¡Hola! Gracias por escribirnos. Responde 1 para ver nuestro horario o 2 para hablar con un asesor.';
export const DEFAULT_HOURS = 'Nuestro horario de atención es: {horario}.';
export const DEFAULT_HANDOFF =
  'Listo, un asesor te responderá por este chat en cuanto esté disponible.';

// ---------------------------------------------------------------------------
// Triggers (matched on normalized text)
// ---------------------------------------------------------------------------

/** Menu options: they match only as the whole trimmed message. */
const HOURS_OPTION = '1';
const HANDOFF_OPTION = '2';

/** Keywords match as whole words, after normalize (no accents, lower case). */
const HOURS_KEYWORDS: ReadonlySet<string> = new Set([
  'horario',
  'hora',
  'horas',
  'abren',
  'abierto',
  'atienden',
  'atencion',
  'cierran',
]);
const HANDOFF_KEYWORDS: ReadonlySet<string> = new Set([
  'asesor',
  'asesora',
  'persona',
  'humano',
  'agente',
  'vendedor',
  'ayuda',
]);

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

/** Trims, lowercases and strips accents ("¿A qué HORA?" → "¿a que hora?"). */
export const normalize = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

const containsKeyword = (words: ReadonlyArray<string>, keywords: ReadonlySet<string>): boolean =>
  words.some((word) => keywords.has(word));

/**
 * Picks the fixed reply for an inbound text, or null to stay silent.
 *
 * Precedence: an explicit intent wins over the greeting, and handoff wins over hours
 * when both keyword families match. Without an intent, only the first inbound text
 * in 24 h gets the greeting.
 */
export const selectFixedReply = ({
  text,
  isFirstInboundInWindow,
}: SelectFixedReplyInput): FixedReplyKind | null => {
  const normalized = normalize(text);
  if (normalized === HANDOFF_OPTION) return 'handoff';
  if (normalized === HOURS_OPTION) return 'hours';

  const words = normalized.split(WORD_SEPARATOR);
  if (containsKeyword(words, HANDOFF_KEYWORDS)) return 'handoff';
  if (containsKeyword(words, HOURS_KEYWORDS)) return 'hours';

  return isFirstInboundInWindow ? 'greeting' : null;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type PlaceholderValues = { readonly negocio: string | null; readonly horario: string | null };

const PLACEHOLDER = /\{(negocio|horario)\}/g;

const presentOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};

/** Fills the placeholders, or returns null when the template is blank or needs a missing value. */
const fillTemplate = (
  template: string | null | undefined,
  values: PlaceholderValues,
): string | null => {
  const present = presentOrNull(template);
  if (present === null) return null;

  let missingValue = false;
  const filled = present.replace(PLACEHOLDER, (_match, name: keyof PlaceholderValues) => {
    const value = values[name];
    if (value === null) missingValue = true;
    return value ?? '';
  });
  return missingValue ? null : filled;
};

/** The first template that can be fully filled. */
const firstFilled = (
  templates: ReadonlyArray<string | null | undefined>,
  values: PlaceholderValues,
): string | null => {
  for (const template of templates) {
    const filled = fillTemplate(template, values);
    if (filled !== null) return filled;
  }
  return null;
};

/**
 * Renders the text of a fixed reply.
 *
 * - greeting: the override, else the default with {negocio}, else the default without a name.
 * - hours:    the default with {horario}; without an hours text it renders the handoff.
 * - handoff:  the override, else the default.
 * An override that needs a value the tenant has not set is skipped, never sent half-filled.
 */
export const renderFixedReply = (
  kind: FixedReplyKind,
  settings: FixedReplySettings = {},
): string => {
  const hours = presentOrNull(settings.hoursText);
  const values: PlaceholderValues = {
    negocio: presentOrNull(settings.businessName),
    // The templates add their own final period: drop one the tenant typed.
    horario: hours === null ? null : presentOrNull(hours.replace(/\.+$/, '')),
  };

  const handoff = firstFilled([settings.handoffText], values) ?? DEFAULT_HANDOFF;

  switch (kind) {
    case 'greeting':
      return (
        firstFilled([settings.greetingText, DEFAULT_GREETING], values) ??
        DEFAULT_GREETING_WITHOUT_NAME
      );
    case 'hours':
      return firstFilled([DEFAULT_HOURS], values) ?? handoff;
    case 'handoff':
      return handoff;
  }
};
