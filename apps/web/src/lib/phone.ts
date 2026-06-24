/**
 * phone.ts — Advisory phone helpers for the dev console.
 *
 * isPeru() mirrors the backend normalizePhoneE164 Peruvian-number check.
 * This is advisory only: the backend remains the authoritative source of truth.
 * A false result means the backend will likely reject normalization and the
 * message will NOT be persisted.
 *
 * Peru mobile pattern: +519XXXXXXXX (E.164, 9 digits after the country code,
 * starting with 9).
 */

/** Strips spaces, dashes, parentheses, and dots from a phone string. */
export function norm(phone: string): string {
  return phone.replace(/[\s\-().]/g, '');
}

/**
 * Returns true if the normalized phone looks like a Peruvian mobile number.
 * Pattern: +519 followed by 8 digits.
 * Advisory mirror of backend normalizePhoneE164 — do NOT use as the sole gate.
 */
export function isPeru(phone: string): boolean {
  return /^\+?519\d{8}$/.test(norm(phone));
}
