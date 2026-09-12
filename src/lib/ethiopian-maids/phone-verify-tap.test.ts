import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  confirmPhoneVerifyTap,
  parsePhoneVerifyPayload,
  phoneVerifyReplyText,
} from './phone-verify-tap'

const TOKEN = 'a'.repeat(32)
const PAYLOAD = `EMVERIFY:NJQvLBtnpyTdEvTc23OThuRRIPd2:${TOKEN}`

describe('parsePhoneVerifyPayload', () => {
  it('accepts the app\'s EMVERIFY:<uid>:<token> shape', () => {
    expect(parsePhoneVerifyPayload(PAYLOAD)).toEqual({ uid: 'NJQvLBtnpyTdEvTc23OThuRRIPd2', token: TOKEN })
  })

  it('rejects anything else — plain text, other prefixes, short tokens, missing uid', () => {
    expect(parsePhoneVerifyPayload('hello')).toBeNull()
    expect(parsePhoneVerifyPayload('EMVERIFY:')).toBeNull()
    expect(parsePhoneVerifyPayload('EMVERIFY::' + TOKEN)).toBeNull()
    expect(parsePhoneVerifyPayload('EMVERIFY:u1:short')).toBeNull()
    expect(parsePhoneVerifyPayload('EMVERIFY:u1:' + 'G'.repeat(32))).toBeNull()
    expect(parsePhoneVerifyPayload(undefined)).toBeNull()
    expect(parsePhoneVerifyPayload(42)).toBeNull()
  })
})

describe('confirmPhoneVerifyTap', () => {
  beforeEach(() => {
    process.env.EM_PHONE_VERIFY_TAP_URL = 'https://fn.test/authPhoneVerifyTap'
    process.env.EM_PHONE_VERIFY_TAP_SECRET = 's3cret'
  })
  afterEach(() => {
    delete process.env.EM_PHONE_VERIFY_TAP_URL
    delete process.env.EM_PHONE_VERIFY_TAP_SECRET
  })

  it('POSTs payload + tapping number with the shared secret and returns the function\'s verdict', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ verified: true, phone: '+971500000001', firstName: 'Abeba' }), { status: 200 }),
    )
    const out = await confirmPhoneVerifyTap({ payload: PAYLOAD, from: '971500000001', fetchImpl })
    expect(out).toEqual({ verified: true, phone: '+971500000001', firstName: 'Abeba' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://fn.test/authPhoneVerifyTap')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-phone-verify-secret']).toBe('s3cret')
    expect(JSON.parse(String(init.body))).toEqual({ payload: PAYLOAD, from: '971500000001' })
  })

  it('passes a refusal through', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ verified: false, reason: 'expired' }), { status: 200 }))
    expect(await confirmPhoneVerifyTap({ payload: PAYLOAD, from: '971500000001', fetchImpl })).toEqual({
      verified: false,
      reason: 'expired',
    })
  })

  it('turns a non-200, a bad body, and a thrown fetch into "unavailable"', async () => {
    expect(
      await confirmPhoneVerifyTap({ payload: PAYLOAD, from: '9715', fetchImpl: vi.fn(async () => new Response('nope', { status: 401 })) }),
    ).toEqual({ verified: false, reason: 'unavailable' })
    expect(
      await confirmPhoneVerifyTap({ payload: PAYLOAD, from: '9715', fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) }),
    ).toEqual({ verified: false, reason: 'unavailable' })
    expect(
      await confirmPhoneVerifyTap({
        payload: PAYLOAD,
        from: '9715',
        fetchImpl: vi.fn(async () => {
          throw new Error('ECONNRESET')
        }),
      }),
    ).toEqual({ verified: false, reason: 'unavailable' })
  })

  it('reports missing configuration instead of calling anything', async () => {
    delete process.env.EM_PHONE_VERIFY_TAP_SECRET
    const fetchImpl = vi.fn()
    expect(await confirmPhoneVerifyTap({ payload: PAYLOAD, from: '9715', fetchImpl })).toEqual({
      verified: false,
      reason: 'not-configured',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('phoneVerifyReplyText', () => {
  it('greets by first name on success and points back to the app', () => {
    expect(phoneVerifyReplyText({ verified: true, phone: '+9715', firstName: 'Abeba' })).toMatch(/^Thanks Abeba! ✅/)
    expect(phoneVerifyReplyText({ verified: true, phone: '+9715', firstName: null })).toMatch(/^✅ Your number is verified/)
  })

  it('has a distinct sentence for every refusal the app can give', () => {
    const reasons = ['invalid', 'not-found', 'expired', 'mismatch', 'already-exists', 'internal', 'unavailable', 'not-configured'] as const
    const texts = reasons.map((reason) => phoneVerifyReplyText({ verified: false, reason }))
    for (const t of texts) expect(t.length).toBeGreaterThan(20)
    expect(phoneVerifyReplyText({ verified: false, reason: 'expired' })).toContain('expired')
    expect(phoneVerifyReplyText({ verified: false, reason: 'mismatch' })).toContain('different number')
    expect(phoneVerifyReplyText({ verified: false, reason: 'already-exists' })).toContain('another Ethiopian Maids account')
  })
})
