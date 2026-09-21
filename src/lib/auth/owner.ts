import { NextResponse } from "next/server";
import { MobileOwnerError, resolveOwnerUserId } from "@/lib/mobile/auth";

/**
 * Operator-only gate for routes that spend credentials owned by the
 * business rather than by the caller: the shared Gmail mailbox
 * (`EMAIL_MAILBOX`), the Vapi account (`VAPI_API_KEY` + phone number), the
 * OpenAI key used for KB embeddings.
 *
 * Why a session check is not enough: the self-hosted GoTrue allows
 * self-signup, so "any authenticated user" is "anyone on the internet".
 * Those routes already scope the *data* to the caller (RLS / `user_id`
 * predicates), which is exactly why a stranger could create their own
 * contact + conversation and then relay mail or place calls through the
 * operator's accounts. The operator is the CRM user that owns the
 * connected WhatsApp number — the same identity the mobile app, outreach
 * and email ingestion already resolve through `resolveOwnerUserId`.
 *
 * Returns a ready-to-send 403 (or the 503 owner-lookup failure) when the
 * caller is not the operator, `null` when they are.
 */
export async function forbidUnlessOwner(
  userId: string,
): Promise<NextResponse | null> {
  let owner: string;
  try {
    owner = await resolveOwnerUserId();
  } catch (e) {
    if (e instanceof MobileOwnerError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
  if (userId !== owner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
