import { simpleParser, type AddressObject } from 'mailparser';

export interface ParsedEmail {
  messageId: string;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  toAddresses: string[];
  subject: string;
  text: string;
  references: string | null;
  autoSubmitted: boolean;
}

/**
 * The single canonical address for a customer: where a reply must be sent AND
 * the identity we look up / key the contact on. `Reply-To` wins over `From`
 * (senders set it precisely so replies reach them), falling back to `From`.
 * Both the relevance gate's known-user lookup and the contact/reply target
 * MUST resolve through here so they cannot disagree.
 */
export function customerAddress(parsed: ParsedEmail): string {
  return parsed.replyTo || parsed.fromEmail;
}

const stripAngles = (id: string | undefined): string => (id ?? '').replace(/^<|>$/g, '').trim();
const firstAddr = (a: AddressObject | AddressObject[] | undefined): { address: string; name: string } | null => {
  const obj = Array.isArray(a) ? a[0] : a;
  const v = obj?.value?.[0];
  return v?.address ? { address: v.address.toLowerCase(), name: v.name ?? '' } : null;
};

export async function parseEmail(rawBase64Url: string): Promise<ParsedEmail> {
  const buf = Buffer.from(rawBase64Url, 'base64url');
  const mail = await simpleParser(buf);

  const from = firstAddr(mail.from);
  const replyTo = firstAddr(mail.replyTo);
  const toList: string[] = [];
  for (const a of ([] as AddressObject[]).concat(mail.to ?? [], mail.cc ?? []))
    for (const v of a.value) if (v.address) toList.push(v.address.toLowerCase());
  const deliveredTo = (mail.headers.get('delivered-to') as string | undefined)?.toLowerCase();
  if (deliveredTo) toList.push(deliveredTo);

  const autoSubmittedHeader = String(mail.headers.get('auto-submitted') ?? '').toLowerCase();
  const precedence = String(mail.headers.get('precedence') ?? '').toLowerCase();
  const autoSubmitted =
    (autoSubmittedHeader !== '' && autoSubmittedHeader !== 'no') ||
    precedence === 'bulk' || precedence === 'list';

  const html = typeof mail.html === 'string' ? mail.html.replace(/<[^>]+>/g, ' ') : '';

  return {
    messageId: stripAngles(mail.messageId),
    fromEmail: from?.address ?? '',
    fromName: from?.name || null,
    replyTo: replyTo?.address ?? null,
    toAddresses: [...new Set(toList)],
    subject: (mail.subject ?? '').trim(),
    text: (mail.text ?? html ?? '').trim(),
    references: (mail.references ? ([] as string[]).concat(mail.references).join(' ') : null),
    autoSubmitted,
  };
}
