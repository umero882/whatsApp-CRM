import { describe, expect, it, vi } from 'vitest';

const sendSpy = vi.fn(async () => ({ id: 'gmail-sent-1' }));
vi.mock('./gmail-client', () => ({ makeGmailClient: () => ({ send: sendSpy }) }));
vi.mock('./oauth', () => ({ getRefreshToken: async () => 'rt' }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => t === 'conversations'
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { subject: 'How do I register?' } }) }) }) }
      : { select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { message_id: 'orig@x', email_thread_id: 'thr-1', email_references: null } }) }) }) }) }) }) },
  }),
}));

import { sendEmailReply } from './send';

describe('sendEmailReply', () => {
  it('sends threaded (In-Reply-To + threadId) and returns the message id', async () => {
    const res = await sendEmailReply({ conversationId: 'conv-1', to: 'jane@example.com', text: 'Here is how.' });
    expect(res.messageId).toBe('gmail-sent-1');
    const arg = sendSpy.mock.calls[0][0];
    expect(arg.threadId).toBe('thr-1');
    const raw = Buffer.from(arg.raw, 'base64url').toString('utf8');
    expect(raw).toContain('In-Reply-To: <orig@x>');
    expect(raw).toContain('Subject: Re: How do I register?');
    expect(raw).toContain('To: jane@example.com');
  });
});
