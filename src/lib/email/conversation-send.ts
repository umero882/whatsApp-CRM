import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sendEmailReply } from './send';

export async function sendEmailConversationMessage(params: {
  userId: string; conversationId: string; text: string;
}): Promise<{ crmMessageId: string; emailMessageId: string }> {
  const sb = supabaseAdmin();
  const { data: conv } = await sb.from('conversations')
    .select('id, contact:contacts(external_id)')
    .eq('id', params.conversationId).eq('user_id', params.userId).eq('channel', 'email').maybeSingle();
  if (!conv) { const e = new Error('Conversation not found') as Error & { status?: number }; e.status = 404; throw e; }
  const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;
  const to = contact?.external_id;
  if (!to) { const e = new Error('No recipient email') as Error & { status?: number }; e.status = 422; throw e; }

  const sent = await sendEmailReply({ conversationId: params.conversationId, to, text: params.text });

  const { data: msg, error } = await sb.from('messages').insert({
    conversation_id: params.conversationId, sender_type: 'agent',
    content_type: 'text', content_text: params.text, message_id: sent.messageId, status: 'sent',
  }).select().single();
  if (error) { const e = new Error('persist failed') as Error & { status?: number }; e.status = 500; throw e; }

  const { data: cfg } = await sb.from('ai_agent_config').select('is_enabled, human_pause_minutes').eq('user_id', params.userId).maybeSingle();
  const patch: Record<string, unknown> = {
    last_message_text: params.text.slice(0, 500), last_message_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (cfg?.is_enabled) patch.ai_paused_until = new Date(Date.now() + Math.max(0, cfg.human_pause_minutes ?? 60) * 60_000).toISOString();
  await sb.from('conversations').update(patch).eq('id', params.conversationId);

  return { crmMessageId: msg.id, emailMessageId: sent.messageId };
}
