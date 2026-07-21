import { describe, expect, it, vi } from 'vitest';

const gmailSend = vi.fn(async () => ({ data: { id: 'sent-123', threadId: 't-1' } }));
const historyList = vi.fn(async () => ({
  data: { history: [{ messagesAdded: [{ message: { id: 'm-1' } }] }] },
}));
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    gmail: () => ({
      users: {
        messages: { send: gmailSend, get: vi.fn(async () => ({ data: { id: 'm-1', threadId: 't-1', raw: 'UkFX', labelIds: ['INBOX'] } })) },
        history: { list: historyList },
        watch: vi.fn(async () => ({ data: { historyId: '99', expiration: '1000' } })),
      },
    }),
  },
}));

import { makeGmailClient } from './gmail-client';

describe('gmail-client', () => {
  it('historyList flattens added message ids', async () => {
    const c = makeGmailClient('refresh-tok');
    const ids = await c.historyList('50');
    expect(ids).toEqual(['m-1']);
  });

  it('send passes raw + threadId to the API', async () => {
    const c = makeGmailClient('refresh-tok');
    const res = await c.send({ raw: 'UkFX', threadId: 't-1' });
    expect(res.id).toBe('sent-123');
    expect(gmailSend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', requestBody: expect.objectContaining({ raw: 'UkFX', threadId: 't-1' }) }),
    );
  });
});
