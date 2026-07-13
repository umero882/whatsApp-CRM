/**
 * Outbound calling — pure helpers for /api/calls/outbound.
 *
 * Lucy (the Vapi voice assistant that answers the CS line) can also
 * place calls: the CRM POSTs to Vapi's /call API with the CS number as
 * caller ID and the customer's number as destination. These helpers
 * build that payload; the route owns auth, DB writes, and the fetch.
 */

export interface OutboundCallInput {
  assistantId: string;
  phoneNumberId: string;
  /** E.164 destination, e.g. "+971588593894". */
  number: string;
  /** Why Lucy is calling — spoken in her opening line. */
  objective?: string | null;
  contactName?: string | null;
}

/**
 * "+971 58 859-3894" | "0097158…" | "58 859 3894" → "+97158…" | null.
 * Accepts anything with 7–15 digits (E.164 bounds); strips a leading
 * "00" international prefix. Rejects short/garbage input. Pure.
 */
export function normalizeDialNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * Lucy's opening line for an outbound call. The default assistant
 * greeting assumes the customer called us — outbound needs Lucy to
 * introduce herself and say why she's calling. Pure.
 */
export function outboundFirstMessage(
  objective?: string | null,
  contactName?: string | null,
): string {
  const greeting = contactName?.trim()
    ? `Hello ${contactName.trim()}!`
    : 'Hello!';
  const why = objective?.trim()
    ? ` I'm calling about ${objective.trim()}.`
    : '';
  return `${greeting} This is Lucy calling from Ethiopian Maids.${why} Do you have a quick moment?`;
}

/** Request body for POST https://api.vapi.ai/call. Pure. */
export function buildVapiOutboundBody(input: OutboundCallInput): Record<string, unknown> {
  return {
    assistantId: input.assistantId,
    phoneNumberId: input.phoneNumberId,
    customer: { number: input.number },
    assistantOverrides: {
      firstMessage: outboundFirstMessage(input.objective, input.contactName),
      variableValues: {
        call_direction: 'outbound',
        call_objective: input.objective?.trim() || 'general follow-up',
        contact_name: input.contactName?.trim() || '',
      },
    },
  };
}
