// One-off: node --loader ts-node/esm scripts/seed-email-oauth.ts <mailbox> <refreshToken>
// Encrypts the refresh token and upserts email_oauth. Run locally with envs loaded.
import { createClient } from '@supabase/supabase-js';
import { encrypt } from '../src/lib/whatsapp/encryption';

const [mailbox, refreshToken] = process.argv.slice(2);
if (!mailbox || !refreshToken) { console.error('usage: seed-email-oauth <mailbox> <refreshToken>'); process.exit(1); }

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { error } = await sb.from('email_oauth').upsert(
  { mailbox, encrypted_refresh_token: encrypt(refreshToken), updated_at: new Date().toISOString() },
  { onConflict: 'mailbox' },
);
if (error) { console.error(error); process.exit(1); }
console.log('seeded email_oauth for', mailbox);
