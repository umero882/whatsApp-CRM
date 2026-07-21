// Verify Google's OIDC push token so only Google Pub/Sub can invoke the route.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export async function verifyPubSubPush(request: Request): Promise<boolean> {
  // The audience is mandatory — without it, any validly-signed Google token
  // (from ANY Google Cloud project, not just ours) would pass verification.
  // Never make this optional.
  const audience = process.env.EMAIL_PUBSUB_AUDIENCE ?? '';
  if (!audience) return false;

  try {
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return false;

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: 'https://accounts.google.com',
      audience,
    });

    // Optional extra pin: Google Pub/Sub push tokens carry the pushing
    // service account's email in the `email` claim. When configured,
    // require it to match so only OUR push subscription's SA can invoke us.
    const saEmail = process.env.EMAIL_PUBSUB_SA_EMAIL ?? '';
    if (saEmail && payload.email !== saEmail) return false;

    return true;
  } catch {
    return false;
  }
}
