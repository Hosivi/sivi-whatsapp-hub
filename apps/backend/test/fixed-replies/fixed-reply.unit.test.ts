/**
 * fixed-reply.unit.test.ts — Unit tests for the pure fixed-reply module.
 * Docker-free: no database, no network.
 *
 * Covers:
 * - normalize: trim, lowercase, strip accents
 * - selectFixedReply: "1"/"2" as the whole message, keywords (accents, upper case,
 *   whole words only), explicit intent over greeting, handoff over hours,
 *   first vs later message, silence
 * - renderFixedReply: placeholders, missing business name, missing hours fallback,
 *   per-tenant overrides
 */

import { describe, expect, it } from 'vitest';
import {
  normalize,
  renderFixedReply,
  selectFixedReply,
} from '../../src/fixed-replies/fixed-reply.js';

const GREETING_NO_NAME =
  '¡Hola! Gracias por escribirnos. Responde 1 para ver nuestro horario o 2 para hablar con un asesor.';
const HANDOFF = 'Listo, un asesor te responderá por este chat en cuanto esté disponible.';

const later = (text: string) => selectFixedReply({ text, isFirstInboundInWindow: false });
const first = (text: string) => selectFixedReply({ text, isFirstInboundInWindow: true });

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe('normalize', () => {
  it('trims, lowercases and strips accents', () => {
    expect(normalize('  ¿A qué HORA Abren?  ')).toBe('¿a que hora abren?');
    expect(normalize('Atención')).toBe('atencion');
    expect(normalize('SEÑORA')).toBe('senora');
  });
});

// ---------------------------------------------------------------------------
// selectFixedReply
// ---------------------------------------------------------------------------

describe('selectFixedReply', () => {
  it('"1" as the whole trimmed message → hours', () => {
    expect(later('1')).toBe('hours');
    expect(later('  1  ')).toBe('hours');
  });

  it('"2" as the whole trimmed message → handoff', () => {
    expect(later('2')).toBe('handoff');
    expect(later(' 2\n')).toBe('handoff');
  });

  it('digits inside a longer message are not menu options', () => {
    expect(later('12')).toBeNull();
    expect(later('quiero 2 polos')).toBeNull();
    expect(later('1.')).toBeNull();
  });

  it('hours keywords match regardless of case and accents', () => {
    expect(later('HORARIO')).toBe('hours');
    expect(later('¿A qué hora abren?')).toBe('hours');
    expect(later('¿Tienen HORAS de atención el domingo?')).toBe('hours');
    expect(later('¿Hasta cuándo ATIENDEN?')).toBe('hours');
    expect(later('¿Está abierto hoy?')).toBe('hours');
    expect(later('¿A qué hora cierran?')).toBe('hours');
    expect(later('Atención')).toBe('hours');
  });

  it('advisor keywords match regardless of case and accents', () => {
    expect(later('Quiero hablar con un ASESOR')).toBe('handoff');
    expect(later('¿Me atiende una asesora?')).toBe('handoff');
    expect(later('Prefiero una persona')).toBe('handoff');
    expect(later('humano por favor')).toBe('handoff');
    expect(later('Pásame con un agente')).toBe('handoff');
    expect(later('¿Hay algún vendedor?')).toBe('handoff');
    expect(later('Necesito AYÚDA')).toBe('handoff');
  });

  it('keywords match whole words only', () => {
    expect(later('ahora no puedo')).toBeNull(); // "ahora" contains "hora"
    expect(later('es para uso personal')).toBeNull(); // "personal" contains "persona"
    expect(later('ayudante')).toBeNull();
  });

  it('when both keyword families match, handoff wins', () => {
    expect(later('Quiero hablar con un asesor sobre el horario')).toBe('handoff');
    expect(first('¿Una persona me dice a qué hora abren?')).toBe('handoff');
  });

  it('an explicit intent wins over the greeting on the first message', () => {
    expect(first('1')).toBe('hours');
    expect(first('2')).toBe('handoff');
    expect(first('Hola, ¿a qué hora abren?')).toBe('hours');
    expect(first('Hola, quiero hablar con un asesor')).toBe('handoff');
  });

  it('the first inbound text in 24 h without an intent → greeting', () => {
    expect(first('Hola')).toBe('greeting');
    expect(first('quiero 2 polos')).toBe('greeting');
  });

  it('a later message without an intent → null (silence)', () => {
    expect(later('Hola')).toBeNull();
    expect(later('gracias')).toBeNull();
    expect(later('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderFixedReply
// ---------------------------------------------------------------------------

describe('renderFixedReply', () => {
  it('greeting with a business name fills {negocio}', () => {
    expect(renderFixedReply('greeting', { businessName: 'Bodega Rosa' })).toBe(
      '¡Hola! Gracias por escribir a Bodega Rosa. Responde 1 para ver nuestro horario o 2 para hablar con un asesor.',
    );
  });

  it('greeting without a business name (absent, null or blank) uses the generic text', () => {
    expect(renderFixedReply('greeting', {})).toBe(GREETING_NO_NAME);
    expect(renderFixedReply('greeting', { businessName: null })).toBe(GREETING_NO_NAME);
    expect(renderFixedReply('greeting', { businessName: '   ' })).toBe(GREETING_NO_NAME);
  });

  it('hours fills {horario}', () => {
    expect(renderFixedReply('hours', { hoursText: 'lunes a sábado, de 9:00 a 20:00' })).toBe(
      'Nuestro horario de atención es: lunes a sábado, de 9:00 a 20:00.',
    );
  });

  it('hours text ending with a period does not produce a double period', () => {
    expect(renderFixedReply('hours', { hoursText: 'lunes a viernes, de 9:00 a 18:00.' })).toBe(
      'Nuestro horario de atención es: lunes a viernes, de 9:00 a 18:00.',
    );
  });

  it('hours without an hours text falls back to the handoff reply', () => {
    expect(renderFixedReply('hours', {})).toBe(HANDOFF);
    expect(renderFixedReply('hours', { hoursText: '  ' })).toBe(HANDOFF);
    expect(renderFixedReply('hours', { handoffText: 'Te escribe una asesora en breve.' })).toBe(
      'Te escribe una asesora en breve.',
    );
  });

  it('handoff uses the default text', () => {
    expect(renderFixedReply('handoff', {})).toBe(HANDOFF);
  });

  it('per-tenant overrides replace the defaults and may use the placeholders', () => {
    const settings = {
      businessName: 'Bodega Rosa',
      hoursText: 'todos los días, de 8:00 a 22:00',
      greetingText: 'Hola, somos {negocio}. Atendemos {horario}. Responde 1 o 2.',
      handoffText: 'En un momento te atiende alguien de {negocio}.',
    };

    expect(renderFixedReply('greeting', settings)).toBe(
      'Hola, somos Bodega Rosa. Atendemos todos los días, de 8:00 a 22:00. Responde 1 o 2.',
    );
    expect(renderFixedReply('handoff', settings)).toBe(
      'En un momento te atiende alguien de Bodega Rosa.',
    );
  });

  it('an override that needs a missing value falls back to the default text', () => {
    expect(renderFixedReply('greeting', { greetingText: 'Bienvenido a {negocio}.' })).toBe(
      GREETING_NO_NAME,
    );
    expect(renderFixedReply('handoff', { handoffText: 'Te atiende {negocio}.' })).toBe(HANDOFF);
  });

  it('a blank override is ignored', () => {
    expect(renderFixedReply('handoff', { handoffText: '   ' })).toBe(HANDOFF);
    expect(renderFixedReply('greeting', { greetingText: '' })).toBe(GREETING_NO_NAME);
  });
});
