/**
 * Auth guard for the admin-mobile → CRM WhatsApp API.
 *
 * Every `/api/mobile/whatsapp/*` route calls `verifyMobileAdmin(request)`:
 *   1. Pull the Bearer Firebase ID token.
 *   2. Verify it (signature + issuer/audience/expiry + admin claim).
 *   3. Resolve the CRM tenant that owns the WhatsApp number and return its
 *      user_id — so every downstream query is scoped to the real owner,
 *      never a client-supplied id.
 */

import type { JWTVerifyGetKey } from "jose";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { verifyFirebaseIdToken } from "./firebase-verify";

export class MobileAuthError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "MobileAuthError";
  }
}

export function isMobileAuthError(e: unknown): e is MobileAuthError {
  return (
    e instanceof MobileAuthError ||
    (typeof e === "object" && e !== null && (e as { name?: string }).name === "MobileAuthError")
  );
}

let _ownerId: string | null = null;

/** Test-only: clear the memoized owner id between cases. */
export function _resetMobileAuthCacheForTests(): void {
  _ownerId = null;
}

/**
 * The CRM account that owns the connected WhatsApp number. Prefer the
 * explicit env override; otherwise fall back to the sole connected
 * `whatsapp_config` row (this is a single-WhatsApp-number business).
 */
async function resolveOwnerUserId(): Promise<string> {
  const envId = process.env.CRM_WHATSAPP_OWNER_USER_ID?.trim();
  if (envId) return envId;
  if (_ownerId) return _ownerId;

  const { data, error } = await supabaseAdmin()
    .from("whatsapp_config")
    .select("user_id")
    .eq("status", "connected")
    .limit(2);

  if (error) throw new MobileAuthError("owner lookup failed");
  if (!data || data.length !== 1) {
    throw new MobileAuthError("no unambiguous WhatsApp owner");
  }
  _ownerId = data[0].user_id as string;
  return _ownerId;
}

function readBearer(request: Request): string {
  const header =
    request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new MobileAuthError("missing bearer token");
  }
  const token = header.slice(7).trim();
  if (!token) throw new MobileAuthError("empty bearer token");
  return token;
}

export interface MobileAdmin {
  userId: string;
  firebaseUid: string;
}

/**
 * @param opts.jwks injectable key resolver for tests. Production omits it and
 *                  uses Google's remote JWKS.
 */
export async function verifyMobileAdmin(
  request: Request,
  opts?: { jwks?: JWTVerifyGetKey },
): Promise<MobileAdmin> {
  const token = readBearer(request);

  let firebaseUid: string;
  try {
    const payload = opts?.jwks
      ? await verifyFirebaseIdToken(token, opts.jwks)
      : await verifyFirebaseIdToken(token);
    firebaseUid = payload.sub!;
  } catch {
    // Collapse every verification failure to a single opaque 401 — never
    // tell the caller which check failed.
    throw new MobileAuthError("invalid token");
  }

  const userId = await resolveOwnerUserId();
  return { userId, firebaseUid };
}
