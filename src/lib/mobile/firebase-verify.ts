/**
 * Verifies Firebase ID tokens minted by the Ethiopian Maids admin-mobile
 * app, WITHOUT a Firebase service-account secret. Firebase ID tokens are
 * RS256 JWTs signed by Google's Secure Token service; we verify the
 * signature against Google's published public keys (JWKS) and assert the
 * issuer/audience/expiry + the app's admin claim.
 *
 * The admin claim shape comes from the app's `syncHasuraClaims` flow:
 *   - top-level `user_type: 'admin'`, and/or
 *   - `https://hasura.io/jwt/claims`.`x-hasura-default-role` === 'site_admin'
 *     (or 'site_admin' present in `x-hasura-allowed-roles`).
 */

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

/** Firebase project id for the Ethiopian Maids apps (public, not a secret). */
export const FIREBASE_PROJECT_ID = "ethiopian-maids";

const ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;

/** Google's public JWKS for Firebase Secure Token (RS256). Public URL. */
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const HASURA_CLAIMS = "https://hasura.io/jwt/claims";
const ADMIN_ROLE = "site_admin";

export interface FirebasePayload extends JWTPayload {
  user_type?: string;
  [HASURA_CLAIMS]?: {
    "x-hasura-default-role"?: string;
    "x-hasura-allowed-roles"?: string[];
  };
}

let _remoteJwks: JWTVerifyGetKey | null = null;
function defaultJwks(): JWTVerifyGetKey {
  if (!_remoteJwks) _remoteJwks = createRemoteJWKSet(new URL(JWKS_URL));
  return _remoteJwks;
}

/**
 * True when the verified token belongs to a site admin. Kept separate so it
 * can be unit-tested against raw payloads.
 */
export function isAdminPayload(p: FirebasePayload): boolean {
  if (p.user_type === "admin") return true;
  const claims = p[HASURA_CLAIMS];
  if (!claims) return false;
  if (claims["x-hasura-default-role"] === ADMIN_ROLE) return true;
  const allowed = claims["x-hasura-allowed-roles"];
  return Array.isArray(allowed) && allowed.includes(ADMIN_ROLE);
}

/**
 * Verify a Firebase ID token and require the admin claim. Throws on any
 * failure (bad signature, wrong issuer/audience, expired, non-admin).
 *
 * @param jwks injectable key resolver — tests pass a local JWKS; production
 *             uses Google's remote JWKS.
 */
export async function verifyFirebaseIdToken(
  token: string,
  jwks: JWTVerifyGetKey = defaultJwks(),
): Promise<FirebasePayload> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: FIREBASE_PROJECT_ID,
  });
  const p = payload as FirebasePayload;
  if (!p.sub) throw new Error("token missing sub");
  if (!isAdminPayload(p)) throw new Error("token lacks admin claim");
  return p;
}
