import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getRefreshToken } from './oauth';
import { makeGmailClient } from './gmail-client';

const MAILBOX = process.env.EMAIL_MAILBOX ?? '';
const FROM = process.env.EMAIL_FROM ?? `"Ethiopian Maids Support" <${MAILBOX}>`;

function buildRaw(args: {
  to: string; subject: string; text: string; inReplyTo: string | null; references: string | null;
}): string {
  const subj = /^re:/i.test(args.subject) ? args.subject : `Re: ${args.subject}`;
  const headers = [
    `From: ${FROM}`,
    `To: ${args.to}`,
    `Subject: ${subj}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (args.inReplyTo) headers.push(`In-Reply-To: <${args.inReplyTo}>`);
  const refs = [args.references, args.inReplyTo ? `<${args.inReplyTo}>` : null].filter(Boolean).join(' ');
  if (refs) headers.push(`References: ${refs}`);
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${args.text}`, 'utf8').toString('base64url');
}

export async function sendEmailReply(args: {
  conversationId: string; to: string; text: string;
}): Promise<{ messageId: string }> {
  const sb = supabaseAdmin();
  const { data: conv } = await sb.from('conversations')
    .select('subject').eq('id', args.conversationId).maybeSingle();
  const { data: lastInbound } = await sb.from('messages')
    .select('message_id, email_thread_id, email_references')
    .eq('conversation_id', args.conversationId).eq('sender_type', 'customer')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  const raw = buildRaw({
    to: args.to,
    subject: conv?.subject ?? '(no subject)',
    text: args.text,
    inReplyTo: lastInbound?.message_id ?? null,
    references: lastInbound?.email_references ?? null,
  });

  const client = makeGmailClient(await getRefreshToken(sb, MAILBOX));
  const sent = await client.send({ raw, threadId: lastInbound?.email_thread_id ?? undefined });
  return { messageId: sent.id };
}
