// Verify Google's OIDC push token so only Google Pub/Sub can invoke the route.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const AUDIENCE = process.env.EMAIL_PUBSUB_AUDIENCE ?? '';

export async function verifyPubSubPush(request: Request): Promise<boolean> {
  try {
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return false;
    await jwtVerify(token, JWKS, {
      issuer: 'https://accounts.google.com',
      ...(AUDIENCE ? { audience: AUDIENCE } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
