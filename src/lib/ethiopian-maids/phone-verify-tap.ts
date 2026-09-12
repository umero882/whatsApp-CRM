/**
 * Ethiopian Maids — phone verification by WhatsApp quick reply.
 *
 * The Ethiopian Maids app sends its users a UTILITY template with one
 * quick-reply button ("Confirm my number"). Meta delivers the tap to THIS
 * webhook (the CRM owns the WABA's callback) as a `button` message whose
 * `payload` is what the app set at send time: `EMVERIFY:<uid>:<token>`.
 *
 * This module recognises that payload, hands it to the app's Cloud Function
 * `authPhoneVerifyTap` (shared secret) — which checks the token, checks
 * that the tapping number is the one the message went to, and links the
 * number to the account — and words the reply the customer sees in the
 * chat. Nothing here touches the CRM's own data; the webhook route stores
 * the tap as a normal inbound message and sends the reply through the
 * usual bot path.
 *
 * Env: EM_PHONE_VERIFY_TAP_URL (the function URL) and
 * EM_PHONE_VERIFY_TAP_SECRET (same value as the function's
 * PHONE_VERIFY_TAP_SECRET). Unset → taps are answered with the
 * "try again from the app" text and logged, never silently dropped.
 */

export const PHONE_VERIFY_PAYLOAD_PREFIX = 'EMVERIFY:'

export interface PhoneVerifyPayload {
  uid: string
  token: string
}

/** Mirrors parseTapPayload in the app's phoneVerification.ts. */
export function parsePhoneVerifyPayload(payload: unknown): PhoneVerifyPayload | null {
  if (typeof payload !== 'string' || !payload.startsWith(PHONE_VERIFY_PAYLOAD_PREFIX)) return null
  const rest = payload.slice(PHONE_VERIFY_PAYLOAD_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const uid = rest.slice(0, sep)
  const token = rest.slice(sep + 1)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !/^[0-9a-f]{32}$/.test(token)) return null
  return { uid, token }
}

export type PhoneVerifyOutcome =
  | { verified: true; phone: string; firstName: string | null }
  | {
      verified: false
      reason:
        | 'invalid'
        | 'not-found'
        | 'expired'
        | 'mismatch'
        | 'already-exists'
        | 'internal'
        | 'unavailable'
        | 'not-configured'
    }

const REQUEST_TIMEOUT_MS = 10_000

/**
 * Ask the app to verify the tap. Never throws: every failure becomes an
 * outcome the caller can put into words.
 */
export async function confirmPhoneVerifyTap(args: {
  payload: string
  /** `messages[].from` — the tapping number's wa_id (digits). */
  from: string
  fetchImpl?: typeof fetch
}): Promise<PhoneVerifyOutcome> {
  const url = process.env.EM_PHONE_VERIFY_TAP_URL
  const secret = process.env.EM_PHONE_VERIFY_TAP_SECRET
  if (!url || !secret) {
    console.error('[phone-verify-tap] EM_PHONE_VERIFY_TAP_URL / _SECRET not set — tap not verified')
    return { verified: false, reason: 'not-configured' }
  }
  const doFetch = args.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-phone-verify-secret': secret,
      },
      body: JSON.stringify({ payload: args.payload, from: args.from }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.error('[phone-verify-tap] function answered', res.status)
      return { verified: false, reason: 'unavailable' }
    }
    const body = (await res.json().catch(() => null)) as PhoneVerifyOutcome | null
    if (!body || typeof body.verified !== 'boolean') {
      return { verified: false, reason: 'unavailable' }
    }
    return body
  } catch (err) {
    console.error('[phone-verify-tap] request failed:', err instanceof Error ? err.message : err)
    return { verified: false, reason: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

/** The chat reply for an outcome — the customer's whole feedback loop. */
export function phoneVerifyReplyText(outcome: PhoneVerifyOutcome): string {
  if (outcome.verified) {
    const hi = outcome.firstName ? `Thanks ${outcome.firstName}! ` : ''
    return `${hi}✅ Your number is verified. Go back to the Ethiopian Maids app to continue.`
  }
  switch (outcome.reason) {
    case 'expired':
      return '⌛ That confirmation has expired. Open the Ethiopian Maids app and tap "Enter a code instead" or Resend to get a new one.'
    case 'mismatch':
      return 'This confirmation was sent to a different number. Check the number in the Ethiopian Maids app and try again.'
    case 'already-exists':
      return 'This number is already linked to another Ethiopian Maids account. Sign in to that account, or use a different number in the app.'
    case 'invalid':
    case 'not-found':
      return 'This confirmation is no longer valid. If you still need to verify your number, open the Ethiopian Maids app and tap Resend.'
    case 'internal':
    case 'unavailable':
    case 'not-configured':
    default:
      return "We couldn't confirm your number just now. Please try again in a minute from the Ethiopian Maids app."
  }
}
