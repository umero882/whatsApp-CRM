import type { ParsedEmail } from './parse';
import type { SupabaseClient } from '@supabase/supabase-js';

const MAILBOX = (process.env.EMAIL_MAILBOX ?? '').toLowerCase();
export const OWN_ADDRESSES: string[] = [
  MAILBOX, 'support@ethiopianmaids.com', 'info@ethiopianmaids.com',
].filter(Boolean);

const BLOCKED_LOCALPARTS = /^(mailer-daemon|postmaster|no-?reply|noreply|bounce|donotreply)@/i;

export function shouldDropEmail(p: ParsedEmail): { drop: boolean; reason: string | null } {
  if (!p.fromEmail) return { drop: true, reason: 'no_sender' };
  if (p.autoSubmitted) return { drop: true, reason: 'auto_submitted' };
  if (BLOCKED_LOCALPARTS.test(p.fromEmail)) return { drop: true, reason: 'system_sender' };
  if (OWN_ADDRESSES.includes(p.fromEmail)) return { drop: true, reason: 'loop_self' };
  return { drop: false, reason: null };
}

export async function alreadyIngested(sb: SupabaseClient, messageId: string): Promise<boolean> {
  if (!messageId) return false;
  const { data } = await sb.from('messages').select('id').eq('message_id', messageId).maybeSingle();
  return !!data;
}
