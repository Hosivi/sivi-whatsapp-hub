/**
 * system-prompt.ts — System prompt builder for the governed AI agent.
 *
 * Implements the per-vertical system prompt construction from Docs/specs/ai-agents.md §5.
 *
 * Design invariants:
 * - D8: Customer text NEVER appears in the system prompt. The system prompt is
 *   constructed ONLY from operator-supplied configuration fields (business_name,
 *   vertical, intent list). Customer messages always remain in the 'user' role.
 * - systemPromptOverride: when non-null, returned VERBATIM without modification.
 *   Operators can fully replace the generated prompt for advanced use cases.
 * - The generated prompt is static per vertical (no dynamic customer content injected).
 */

import type { TenantAiConfig } from '../db/schema/tenant-ai-config.schema.js';

// ---------------------------------------------------------------------------
// tienda_general intents — human-readable labels for the system prompt.
// Enum values: ver_catalogo | hacer_pedido | consultar_precio | estado_pedido | otro
// ---------------------------------------------------------------------------

const TIENDA_GENERAL_INTENTS = [
  'ver catálogo de productos',
  'hacer pedido',
  'consultar precio de productos',
  'estado de pedido',
] as const;

// ---------------------------------------------------------------------------
// buildTiendaGeneralSystemPrompt
// ---------------------------------------------------------------------------

/**
 * Builds the system prompt for a tienda_general AI agent.
 *
 * If config.systemPromptOverride is non-null, it is returned verbatim.
 * Otherwise, the ai-agents.md §5 template is filled with config.businessName
 * and the tienda_general intent list.
 *
 * @param config - TenantAiConfig row (pre-loaded; no DB query inside this function).
 * @returns The system prompt string to pass as the `system` parameter to LlmAdapter.complete().
 */
export function buildTiendaGeneralSystemPrompt(config: TenantAiConfig): string {
  // Return the operator override verbatim when present.
  if (config.systemPromptOverride !== null) {
    return config.systemPromptOverride;
  }

  const intentList = TIENDA_GENERAL_INTENTS.join(', ');

  // Fill the ai-agents.md §5 template.
  // NO customer text interpolated here — all values come from operator config.
  return `Sos el asistente de ${config.businessName}, una tienda en Perú.
Tu función es EXCLUSIVAMENTE ayudar a los clientes del negocio con: ${intentList}.

Reglas que siempre cumplís:
- Respondés en español, de manera directa y amable, sin ser demasiado formal.
- Cuando el cliente quiere pagar, generás un link de pago seguro (Culqi/Izipay). NUNCA pedís datos de tarjeta en el chat.
- Antes de emitir un comprobante de pago, preguntás si el cliente va a facturar a nombre de una empresa (→ factura) o como persona natural (→ boleta). En el primer caso pedís su RUC; en el segundo, su DNI.
- Si no entendés lo que el cliente escribió, respondés con el menú de opciones.
- NUNCA respondés preguntas que no tengan que ver con ${config.businessName}.
- Cuando el cliente pide hablar con una persona, invocás escalateToHuman sin hacer más preguntas.`;
}
