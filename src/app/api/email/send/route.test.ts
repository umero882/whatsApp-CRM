import { describe, expect, it, vi, beforeEach } from 'vitest';

let authUser: { id: string } | null = { id: 'u1' };
const sendSpy = vi.fn(async (_args?: unknown) => ({ crmMessageId: 'm-1', emailMessageId: 'eml-1' }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser }, error: null }) },
  }),
}));
vi.mock('@/lib/email/conversation-send', () => ({
  sendEmailConversationMessage: (args: unknown) => sendSpy(args),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('rate limited', { status: 429 }),
  RATE_LIMITS: { send: {} },
}));

import { POST } from './route';

function post(body: unknown): Request {
  return new Request('http://localhost/api/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authUser = { id: 'u1' };
  sendSpy.mockClear();
});

describe('POST /api/email/send', () => {
  it('sends a threaded email reply for the authenticated owner', async () => {
    const res = await POST(post({ conversation_id: 'conv-1', content_text: 'Here is how.' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message_id: 'm-1', email_message_id: 'eml-1' });
    expect(sendSpy).toHaveBeenCalledWith({ userId: 'u1', conversationId: 'conv-1', text: 'Here is how.' });
  });

  it('rejects an unauthenticated request', async () => {
    authUser = null;
    const res = await POST(post({ conversation_id: 'conv-1', content_text: 'hi' }));
    expect(res.status).toBe(401);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('requires content_text', async () => {
    const res = await POST(post({ conversation_id: 'conv-1', content_text: '   ' }));
    expect(res.status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('surfaces a 404 from the send helper (conversation not found / wrong channel)', async () => {
    sendSpy.mockRejectedValueOnce(Object.assign(new Error('Conversation not found'), { status: 404 }));
    const res = await POST(post({ conversation_id: 'nope', content_text: 'hi' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Conversation not found' });
  });
});
