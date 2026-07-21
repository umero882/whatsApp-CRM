import { describe, expect, it, vi } from 'vitest';

vi.mock('./send', () => ({ sendEmailReply: async () => ({ messageId: 'eml-1' }) }));

const insertMsg = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'crm-1' }, error: null }) }) }));
const convUpdateEq = vi.fn(async () => ({ error: null }));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => {
      if (t === 'conversations') return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'conv-1', contact: { external_id: 'jane@example.com' } } }) }) }) }) }),
        update: () => ({ eq: convUpdateEq }),
      } as any;
      if (t === 'messages') return { insert: insertMsg } as any;
      if (t === 'ai_agent_config') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_enabled: true, human_pause_minutes: 60 } }) }) }) } as any;
      return {} as any;
    },
  }),
}));

import { sendEmailConversationMessage } from './conversation-send';

describe('sendEmailConversationMessage', () => {
  it('sends a threaded email + persists an agent(human) message', async () => {
    const r = await sendEmailConversationMessage({ userId: 'owner-1', conversationId: 'conv-1', text: 'Here you go.' });
    expect(r).toEqual({ crmMessageId: 'crm-1', emailMessageId: 'eml-1' });
    expect(insertMsg).toHaveBeenCalledWith(expect.objectContaining({ sender_type: 'agent', content_text: 'Here you go.', message_id: 'eml-1', status: 'sent' }));
  });
});
