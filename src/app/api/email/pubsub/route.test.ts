import { describe, expect, it, vi } from 'vitest';

// NOTE: vi.mock factories can only close over `vi.hoisted()` values (or
// `mock`-prefixed vars) — plain top-level consts hit a TDZ ReferenceError at
// runtime because vi.mock calls are hoisted above them. Hoisting these here
// keeps every mock's behavior/assertions identical to the spec.
const { getRaw, runAgent, state, createdConv, msg } = vi.hoisted(() => ({
  getRaw: vi.fn(async () => ({
    raw: Buffer.from(
      'From: Jane <jane@example.com>\r\nTo: support@ethiopianmaids.com\r\nSubject: register\r\nMessage-ID: <m1@x>\r\n\r\nhow do I sign up?',
      'utf8',
    ).toString('base64url'),
    threadId: 'thr-1',
    labelIds: ['INBOX'],
  })),
  runAgent: vi.fn(async () => ({ kind: 'replied' })),
  state: { last_history_id: '10' },
  createdConv: { id: 'conv-1' },
  msg: { insertResult: { data: { id: 'msg-1' }, error: null } as { data: unknown; error: { code?: string; message: string } | null } },
}));

vi.mock('@/lib/email/oidc', () => ({ verifyPubSubPush: async () => true }));
vi.mock('@/lib/mobile/auth', () => ({ resolveOwnerUserId: async () => 'owner-1' }));
vi.mock('@/lib/email/gmail-client', () => ({ makeGmailClient: () => ({ historyList: async () => ['m-1'], getRaw, addLabel: vi.fn() }) }));
vi.mock('@/lib/email/oauth', () => ({ getRefreshToken: async () => 'rt' }));
vi.mock('@/lib/email/relevance', () => ({ isCustomerEmail: async () => ({ isCustomer: true, reason: 'known_user' }) }));
vi.mock('@/lib/ai/agent', () => ({ runAgent }));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => {
      if (t === 'email_sync_state') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state }) }) }), update: () => ({ eq: async () => ({}) }) } as any;
      if (t === 'messages') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }), insert: () => ({ select: () => ({ single: async () => msg.insertResult }) }) } as any;
      if (t === 'contacts') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }), insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'c-1' } }) }) }) } as any;
      if (t === 'conversations') return { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }), insert: () => ({ select: () => ({ single: async () => ({ data: createdConv }) }) }), update: () => ({ eq: async () => ({}) }) } as any;
      // ai_provider_config / ai_agent_config (and anything else): no row configured.
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) } as any;
    },
  }),
}));

import { POST } from './route';

it('creates an email conversation and dispatches the agent', async () => {
  const req = new Request('http://x/api/email/pubsub', {
    method: 'POST',
    body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: 'nextechlabs.dev@gmail.com', historyId: '20' })).toString('base64') } }),
  });
  const res = await POST(req);
  const json = await res.json();
  expect(res.status).toBe(200);
  expect(json.created).toBe(1);
  expect(runAgent).toHaveBeenCalledWith('conv-1');
});

it('treats a Gmail 404 (message gone) as skip, not errored — so the cursor can advance', async () => {
  getRaw.mockRejectedValueOnce({ code: 404, message: 'Requested entity was not found.' });
  const req = new Request('http://x/api/email/pubsub', {
    method: 'POST',
    body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ historyId: '21' })).toString('base64') } }),
  });
  const res = await POST(req);
  const json = await res.json();
  expect(res.status).toBe(200);
  expect(json.errored).toBe(0); // permanent 404 must NOT hold the cursor
  expect(json.skipped).toBe(1);
  expect(json.created).toBe(0);
});

it('treats a duplicate Message-ID (concurrent-push race, 23505) as skip — no re-run, no errored', async () => {
  runAgent.mockClear();
  msg.insertResult = { data: null, error: { code: '23505', message: 'duplicate key' } };
  const req = new Request('http://x/api/email/pubsub', {
    method: 'POST',
    body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ historyId: '22' })).toString('base64') } }),
  });
  const res = await POST(req);
  const json = await res.json();
  msg.insertResult = { data: { id: 'msg-1' }, error: null }; // restore
  expect(res.status).toBe(200);
  expect(json.errored).toBe(0);   // race loser must NOT hold the cursor
  expect(json.skipped).toBe(1);
  expect(json.created).toBe(0);
  expect(runAgent).not.toHaveBeenCalled(); // must NOT double-dispatch the agent
});
