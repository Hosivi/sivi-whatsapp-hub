import { z } from 'zod';

/**
 * Hub→CRM boundary contract.
 * Emitted by sivi-whatsapp-hub when a WhatsApp contact is captured and routed to SiviHub CRM.
 * This schema is replicated (not yet a published package) — keep both sides in sync.
 */
export const contactLeadSchema = z.object({
  external_id: z.string(),
  phone_e164: z.string(),
  full_name: z.string(),
  source: z.literal('whatsapp'),
  intent: z.string().optional(),
  intent_confidence: z.number().optional(),
  tags: z.array(z.string()).optional(),
  form_payload: z.unknown().optional(),
  captured_at: z.string(),
  tenant_id: z.string(),
});

export type ContactLead = z.infer<typeof contactLeadSchema>;
