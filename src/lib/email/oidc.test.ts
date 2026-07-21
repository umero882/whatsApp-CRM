import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: vi.mock factories can only close over `vi.hoisted()` values (or
// `mock`-prefixed vars) — plain top-level consts hit a TDZ ReferenceError at
// runtime because vi.mock calls are hoisted above them.
const { jwtVerify } = vi.hoisted(() => ({ jwtVerify: vi.fn() }));

vi.mock('jose', () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify,
}));

import { verifyPubSubPush } from './oidc';

function reqWithToken(token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request('http://x/api/email/pubsub', { headers });
}

describe('verifyPubSubPush', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.EMAIL_PUBSUB_AUDIENCE;
    delete process.env.EMAIL_PUBSUB_SA_EMAIL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('denies when EMAIL_PUBSUB_AUDIENCE is unset', async () => {
    const ok = await verifyPubSubPush(reqWithToken('tok'));
    expect(ok).toBe(false);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('denies when EMAIL_PUBSUB_AUDIENCE is an empty string', async () => {
    process.env.EMAIL_PUBSUB_AUDIENCE = '';
    const ok = await verifyPubSubPush(reqWithToken('tok'));
    expect(ok).toBe(false);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('denies when there is no bearer token', async () => {
    process.env.EMAIL_PUBSUB_AUDIENCE = 'https://example.com/api/email/pubsub';
    const ok = await verifyPubSubPush(reqWithToken(null));
    expect(ok).toBe(false);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('always enforces the audience claim in jwtVerify', async () => {
    process.env.EMAIL_PUBSUB_AUDIENCE = 'https://example.com/api/email/pubsub';
    jwtVerify.mockResolvedValueOnce({ payload: {} });
    await verifyPubSubPush(reqWithToken('tok'));
    expect(jwtVerify).toHaveBeenCalledWith(
      'tok',
      expect.anything(),
      expect.objectContaining({
        issuer: 'https://accounts.google.com',
        audience: 'https://example.com/api/email/pubsub',
      }),
    );
  });

  it('denies when jwtVerify rejects (e.g. wrong aud/issuer/signature)', async () => {
    process.env.EMAIL_PUBSUB_AUDIENCE = 'https://example.com/api/email/pubsub';
    jwtVerify.mockRejectedValueOnce(new Error('audience mismatch'));
    const ok = await verifyPubSubPush(reqWithToken('tok'));
    expect(ok).toBe(false);
  });

  it('allows a verified token when EMAIL_PUBSUB_SA_EMAIL is not configured', async () => {
    process.env.EMAIL_PUBSUB_AUDIENCE = 'https://example.com/api/email/pubsub';
    jwtVerify.mockResolvedValueOnce({ payload: { email: 'whatever@x.iam.gserviceaccount.com' } });
    const ok = await verifyPubSubPush(reqWithToken('tok'));
    expect(ok).toBe(true);
  });

  it('denies when EMAIL_PUBSUB_SA_EMAIL is set but the token email does not match', async () => {
    process.env.EMAIL_PUBSUB_AUDIENCE = 'https://example.com/api/email/pubsub';
    process.env.EMAIL_PUBSUB_SA_EMAIL = 'pubsub-pusher@my-project.iam.gserviceaccount.com';
    jwtVerify.mockResolvedValueOnce({ payload: { email: 'someone-else@other-project.iam.gserviceaccount.com' } });
    const ok = await verifyPubSubPush(reqWithToken('tok'));
    expect(ok).toBe(false);
  });

  it('allows when EMAIL_PUBSUB_SA_EMAIL matches the verified token email', async () => {
    process.env.EMAIL_PUBSUB_AUDIENCE = 'https://example.com/api/email/pubsub';
    process.env.EMAIL_PUBSUB_SA_EMAIL = 'pubsub-pusher@my-project.iam.gserviceaccount.com';
    jwtVerify.mockResolvedValueOnce({ payload: { email: 'pubsub-pusher@my-project.iam.gserviceaccount.com' } });
    const ok = await verifyPubSubPush(reqWithToken('tok'));
    expect(ok).toBe(true);
  });
});
