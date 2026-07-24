import type { SupabaseClient } from '@supabase/supabase-js';

// Postgres unique_violation. The find-then-insert below can race a concurrent
// Gmail push; the loser hits the unique index (migration 022) and we re-select
// the winner rather than erroring the whole batch.
const UNIQUE_VIOLATION = '23505';

export async function findOrCreateEmailContact(
  sb: SupabaseClient, userId: string, email: string, name: string | null,
): Promise<{ id: string }> {
  const selectExisting = () => sb.from('contacts')
    .select('id').eq('user_id', userId).eq('external_id', email).maybeSingle();

  const { data: existing } = await selectExisting();
  if (existing) return { id: existing.id };
  const { data, error } = await sb.from('contacts')
    .insert({ user_id: userId, external_id: email, name: name || email })
    .select().single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const { data: raced } = await selectExisting();
      if (raced) return { id: raced.id };
    }
    throw new Error(`create email contact failed: ${error.message}`);
  }
  return { id: data.id };
}

export async function findOrCreateEmailConversation(
  sb: SupabaseClient, userId: string, contactId: string, subject: string,
): Promise<{ id: string }> {
  const selectExisting = () => sb.from('conversations')
    .select('id').eq('user_id', userId).eq('contact_id', contactId).eq('channel', 'email').maybeSingle();

  const { data: existing } = await selectExisting();
  if (existing) return { id: existing.id };
  const { data, error } = await sb.from('conversations')
    .insert({ user_id: userId, contact_id: contactId, channel: 'email', subject: subject || null })
    .select().single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const { data: raced } = await selectExisting();
      if (raced) return { id: raced.id };
    }
    throw new Error(`create email conversation failed: ${error.message}`);
  }
  return { id: data.id };
}

export async function insertInboundEmailMessage(sb: SupabaseClient, args: {
  conversationId: string; text: string; messageId: string; threadId: string;
  references: string | null; headers: Record<string, unknown>;
}): Promise<{ id: string; duplicate: boolean }> {
  const { data, error } = await sb.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'customer',
    content_type: 'text',
    content_text: args.text,
    message_id: args.messageId,
    email_thread_id: args.threadId,
    email_references: args.references,
    email_headers: args.headers,
    status: 'delivered',
  }).select('id').single();
  if (error) {
    // Two overlapping Gmail pushes can both pass the alreadyIngested() check and
    // race to insert the same Message-ID; the loser hits uq_messages_email_message_id.
    // That means another push already ingested this message (and fired the agent),
    // so this is a benign no-op — report it as a duplicate so the caller skips it
    // rather than counting it as a hard error (which would wedge the history cursor).
    if (error.code === UNIQUE_VIOLATION) return { id: '', duplicate: true };
    throw new Error(`insert inbound email message failed: ${error.message}`);
  }
  await sb.from('conversations').update({
    last_message_text: args.text.slice(0, 500) || '[email]',
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', args.conversationId);
  return { id: data.id, duplicate: false };
}
