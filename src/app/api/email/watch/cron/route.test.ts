import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email/gmail-client', () => ({ makeGmailClient: () => ({ watch: async () => ({ historyId: '77', expiration: '1699999999000' }) }) }));
vi.mock('@/lib/email/oauth', () => ({ getRefreshToken: async () => 'rt' }));
const upsert = vi.fn(async () => ({ error: null }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from: () => ({ upsert }) }) }));

import { GET } from './route';

describe('email watch cron', () => {
  it('401 without the secret', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'sekret';
    const res = await GET(new Request('http://x/api/email/watch/cron'));
    expect(res.status).toBe(401);
  });
  it('registers a watch + stores historyId with the secret', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'sekret';
    process.env.EMAIL_PUBSUB_TOPIC = 'projects/p/topics/gmail-inbound';
    const res = await GET(new Request('http://x/api/email/watch/cron', { headers: { 'x-cron-secret': 'sekret' } }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.historyId).toBe('77');
    expect(upsert).toHaveBeenCalled();
  });
});
