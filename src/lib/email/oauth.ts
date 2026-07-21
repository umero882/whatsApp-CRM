import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';

export async function getRefreshToken(sb: SupabaseClient, mailbox: string): Promise<string> {
  const { data, error } = await sb.from('email_oauth')
    .select('encrypted_refresh_token').eq('mailbox', mailbox).single();
  if (error || !data?.encrypted_refresh_token) throw new Error(`no email_oauth row for ${mailbox}`);
  return decrypt(data.encrypted_refresh_token);
}
