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

import { NextResponse } from "next/server";
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

/**
 * Server-side/config failure (owner lookup errored or ambiguous) — the token
 * was fine. Deliberately NOT a MobileAuthError so routes surface a retryable
 * 5xx instead of a 401, which mobile clients read as "session dead → log out".
 */
export class MobileOwnerError extends Error {
  readonly status = 503;
  constructor(message = "WhatsApp owner unavailable") {
    super(message);
    this.name = "MobileOwnerError";
  }
}

export function isMobileAuthError(e: unknown): e is MobileAuthError {
  return (
    e instanceof MobileAuthError ||
    (typeof e === "object" && e !== null && (e as { name?: string }).name === "MobileAuthError")
  );
}

/**
 * Map a `verifyMobileAdmin` rejection to a response: 401 for a bad token,
 * 503 for a backend/owner-config problem. Returns null for anything else so
 * the caller rethrows (→ 500). Keeps all mobile routes' catch blocks uniform.
 */
export function mobileAuthErrorResponse(e: unknown): NextResponse | null {
  if (isMobileAuthError(e)) {
    return NextResponse.json({ error: e.message }, { status: 401 });
  }
  if (e instanceof MobileOwnerError) {
    return NextResponse.json(
      { error: "WhatsApp backend temporarily unavailable" },
      { status: 503 },
    );
  }
  return null;
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

  if (error) throw new MobileOwnerError("owner lookup failed");
  if (!data || data.length !== 1) {
    throw new MobileOwnerError("no unambiguous WhatsApp owner");
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
