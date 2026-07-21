import { customerAddress, type ParsedEmail } from './parse';
import type { ChatProvider } from '@/lib/ai/providers/types';

const PROFILE_BY_EMAIL = `query($email:String!){ profiles(where:{email:{_eq:$email}}, limit:1){ id } }`;

async function isKnownUser(hasuraUrl: string, hasuraSecret: string, email: string): Promise<boolean> {
  try {
    const res = await fetch(hasuraUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hasura-admin-secret': hasuraSecret },
      body: JSON.stringify({ query: PROFILE_BY_EMAIL, variables: { email } }),
    });
    const json = await res.json();
    return (json?.data?.profiles?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

const GATE_PROMPT = `You are a triage filter for Ethiopian Maids, a domestic-worker marketplace (maids, sponsors, agencies; registration, bookings, subscriptions, the app).
Decide if the email is from or about a prospective/actual Ethiopian Maids customer or their inquiry.
Answer with exactly "YES" or "NO".`;

export async function isCustomerEmail(args: {
  parsed: ParsedEmail; hasuraUrl: string; hasuraSecret: string; provider: ChatProvider;
}): Promise<{ isCustomer: boolean; reason: string }> {
  const { parsed, hasuraUrl, hasuraSecret, provider } = args;
  // Look up the SAME address we reply to / key the contact on (Reply-To ?? From),
  // so "known customer" and the reply target never disagree.
  if (hasuraUrl && hasuraSecret && (await isKnownUser(hasuraUrl, hasuraSecret, customerAddress(parsed))))
    return { isCustomer: true, reason: 'known_user' };

  const text = await provider.chat({
    messages: [
      { role: 'system', content: GATE_PROMPT },
      { role: 'user', content: `Subject: ${parsed.subject}\n\n${parsed.text.slice(0, 1500)}` },
    ],
    temperature: 0,
    maxTokens: 3,
  });
  const yes = /yes/i.test((text ?? '').trim());
  return { isCustomer: yes, reason: yes ? 'llm_related' : 'not_related' };
}
