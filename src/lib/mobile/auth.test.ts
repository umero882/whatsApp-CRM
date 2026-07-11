import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";

import {
  FIREBASE_PROJECT_ID,
  isAdminPayload,
  verifyFirebaseIdToken,
  type FirebasePayload,
} from "./firebase-verify";

// supabaseAdmin is mocked so the owner-fallback path is deterministic.
const fromMock = vi.fn();
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ from: fromMock }),
}));

import {
  MobileAuthError,
  verifyMobileAdmin,
  isMobileAuthError,
  _resetMobileAuthCacheForTests,
} from "./auth";

const ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const ADMIN_CLAIM = { user_type: "admin" };

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeEach(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const other = await generateKeyPair("RS256", { extractable: true });
  otherPrivateKey = other.privateKey;

  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwks = createLocalJWKSet({ keys: [jwk] });

  _resetMobileAuthCacheForTests();
  delete process.env.CRM_WHATSAPP_OWNER_USER_ID;
  fromMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface SignOpts {
  key?: CryptoKey;
  iss?: string;
  aud?: string;
  sub?: string;
  expSeconds?: number; // absolute epoch seconds
  claims?: Record<string, unknown>;
}

async function signToken(opts: SignOpts = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...ADMIN_CLAIM, ...(opts.claims ?? {}) })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt(nowSec - 60)
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? FIREBASE_PROJECT_ID)
    .setSubject(opts.sub ?? "admin-uid-123")
    .setExpirationTime(opts.expSeconds ?? nowSec + 3600)
    .sign(opts.key ?? privateKey);
}

function reqWith(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request("https://crm.example/api/mobile/whatsapp/stats", { headers });
}

// ── isAdminPayload ──────────────────────────────────────────────

describe("isAdminPayload", () => {
  it("accepts user_type=admin", () => {
    expect(isAdminPayload({ user_type: "admin" } as FirebasePayload)).toBe(true);
  });
  it("accepts site_admin default role", () => {
    expect(
      isAdminPayload({
        "https://hasura.io/jwt/claims": { "x-hasura-default-role": "site_admin" },
      } as FirebasePayload),
    ).toBe(true);
  });
  it("accepts site_admin in allowed roles", () => {
    expect(
      isAdminPayload({
        "https://hasura.io/jwt/claims": {
          "x-hasura-allowed-roles": ["user", "site_admin"],
        },
      } as FirebasePayload),
    ).toBe(true);
  });
  it("rejects a non-admin payload", () => {
    expect(
      isAdminPayload({
        user_type: "maid",
        "https://hasura.io/jwt/claims": { "x-hasura-default-role": "maid" },
      } as FirebasePayload),
    ).toBe(false);
  });
});

// ── verifyFirebaseIdToken ───────────────────────────────────────

describe("verifyFirebaseIdToken", () => {
  it("verifies a valid admin token (user_type)", async () => {
    const p = await verifyFirebaseIdToken(await signToken(), jwks);
    expect(p.sub).toBe("admin-uid-123");
  });

  it("verifies a valid admin token (site_admin claim)", async () => {
    const token = await signToken({
      claims: {
        user_type: "staff",
        "https://hasura.io/jwt/claims": { "x-hasura-default-role": "site_admin" },
      },
    });
    await expect(verifyFirebaseIdToken(token, jwks)).resolves.toMatchObject({
      sub: "admin-uid-123",
    });
  });

  it("rejects a non-admin token", async () => {
    const token = await signToken({
      claims: {
        user_type: "maid",
        "https://hasura.io/jwt/claims": { "x-hasura-default-role": "maid" },
      },
    });
    await expect(verifyFirebaseIdToken(token, jwks)).rejects.toThrow(/admin/);
  });

  it("rejects an expired token", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await signToken({ expSeconds: nowSec - 10 });
    await expect(verifyFirebaseIdToken(token, jwks)).rejects.toThrow();
  });

  it("rejects a wrong issuer", async () => {
    const token = await signToken({ iss: "https://evil.example/x" });
    await expect(verifyFirebaseIdToken(token, jwks)).rejects.toThrow();
  });

  it("rejects a wrong audience", async () => {
    const token = await signToken({ aud: "some-other-project" });
    await expect(verifyFirebaseIdToken(token, jwks)).rejects.toThrow();
  });

  it("rejects a token signed by a different key", async () => {
    const token = await signToken({ key: otherPrivateKey });
    await expect(verifyFirebaseIdToken(token, jwks)).rejects.toThrow();
  });
});

// ── verifyMobileAdmin ───────────────────────────────────────────

describe("verifyMobileAdmin", () => {
  it("returns the env-configured owner id for a valid token", async () => {
    process.env.CRM_WHATSAPP_OWNER_USER_ID = "owner-from-env";
    const res = await verifyMobileAdmin(reqWith(await signToken()), { jwks });
    expect(res).toEqual({ userId: "owner-from-env", firebaseUid: "admin-uid-123" });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("falls back to the sole connected whatsapp_config owner", async () => {
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({ limit: () => Promise.resolve({ data: [{ user_id: "owner-db" }], error: null }) }),
      }),
    });
    const res = await verifyMobileAdmin(reqWith(await signToken()), { jwks });
    expect(res.userId).toBe("owner-db");
  });

  it("throws when the owner is ambiguous (multiple configs)", async () => {
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          limit: () =>
            Promise.resolve({ data: [{ user_id: "a" }, { user_id: "b" }], error: null }),
        }),
      }),
    });
    await expect(verifyMobileAdmin(reqWith(await signToken()), { jwks })).rejects.toBeInstanceOf(
      MobileAuthError,
    );
  });

  it("rejects a missing Authorization header", async () => {
    await expect(verifyMobileAdmin(reqWith(undefined), { jwks })).rejects.toBeInstanceOf(
      MobileAuthError,
    );
  });

  it("rejects an invalid token with an opaque error", async () => {
    process.env.CRM_WHATSAPP_OWNER_USER_ID = "owner-from-env";
    const token = await signToken({ key: otherPrivateKey });
    const err = await verifyMobileAdmin(reqWith(token), { jwks }).catch((e) => e);
    expect(isMobileAuthError(err)).toBe(true);
    expect(err.message).toBe("invalid token");
  });
});
