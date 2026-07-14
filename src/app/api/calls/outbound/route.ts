import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { buildVapiOutboundBody, normalizeDialNumber } from '@/lib/calls/outbound';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/calls/outbound
 *
 * Body: { contact_id?: UUID, phone?: string, objective?: string }
 * (one of contact_id / phone is required)
 *
 * Lucy places a phone call from the CS line (+1 689 345-9115) to the
 * given customer. A `voice_calls` row is created immediately with
 * status "queued"; the Vapi end-of-call report later fills in the
 * duration, summary, transcript, and recording, and mirrors the call
 * into the contact's conversation timeline.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`call:${user.id}`, RATE_LIMITS.outboundCall);
    if (!limit.success) return rateLimitResponse(limit);

    // Computed-key lookups: static `process.env.X` member reads can be
    // inlined at build time by this Next/Turbopack version, freezing
    // whatever the BUILD environment had (undefined, for vars added in
    // Coolify afterwards). process.env[k] with a variable key is always
    // resolved at request time from the real container env.
    const envAt = (k: string): string | undefined => process.env[k];
    const apiKey = envAt('VAPI_API_KEY');
    const phoneNumberId = envAt('VAPI_PHONE_NUMBER_ID');
    const assistantId = envAt('VAPI_ASSISTANT_ID') ?? envAt('NEXT_PUBLIC_VAPI_ASSISTANT_ID');
    if (!apiKey || !phoneNumberId || !assistantId) {
      const missing = [
        !apiKey && 'VAPI_API_KEY',
        !phoneNumberId && 'VAPI_PHONE_NUMBER_ID',
        !assistantId && 'VAPI_ASSISTANT_ID',
      ]
        .filter(Boolean)
        .join(', ');
      return NextResponse.json(
        { error: `Outbound calling not configured — missing at runtime: ${missing}.` },
        { status: 503 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      contact_id?: string;
      phone?: string;
      objective?: string;
    };

    // Resolve the destination: a CRM contact (preferred — links the
    // call to their conversation) or a raw phone number.
    let contactId: string | null = null;
    let contactName: string | null = null;
    let rawPhone = body.phone ?? null;
    if (body.contact_id) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('id', body.contact_id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!contact) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
      }
      contactId = contact.id;
      contactName = contact.name;
      rawPhone = contact.phone;
    }

    const number = normalizeDialNumber(rawPhone);
    if (!number) {
      return NextResponse.json(
        { error: 'A valid phone number is required (7–15 digits).' },
        { status: 400 },
      );
    }

    const objective =
      typeof body.objective === 'string' && body.objective.trim()
        ? body.objective.trim().slice(0, 500)
        : null;

    const res = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildVapiOutboundBody({ assistantId, phoneNumberId, number, objective, contactName }),
      ),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      console.error('[calls/outbound] Vapi call failed:', res.status, detail);
      return NextResponse.json(
        { error: `Could not place the call (Vapi ${res.status}).` },
        { status: 502 },
      );
    }
    const vapiCall = (await res.json()) as { id?: string };
    if (!vapiCall.id) {
      return NextResponse.json({ error: 'Vapi returned no call id.' }, { status: 502 });
    }

    // Pre-create the structured row so the Calls page shows the call
    // immediately; the end-of-call webhook merges results into it.
    // Admin client — voice_calls has no INSERT policy for users.
    const admin = supabaseAdmin();
    let conversationId: string | null = null;
    if (contactId) {
      const { data: conv } = await admin
        .from('conversations')
        .select('id')
        .eq('user_id', user.id)
        .eq('contact_id', contactId)
        .maybeSingle();
      conversationId = conv?.id ?? null;
    }
    const { error: insertError } = await admin.from('voice_calls').insert({
      user_id: user.id,
      vapi_call_id: vapiCall.id,
      caller_phone: number,
      contact_id: contactId,
      conversation_id: conversationId,
      direction: 'outbound',
      status: 'queued',
      objective,
    });
    if (insertError) {
      // The call is already ringing — log loudly but don't fail the request.
      console.error('[calls/outbound] voice_calls insert failed:', insertError.message);
    }

    return NextResponse.json({ ok: true, call_id: vapiCall.id, number });
  } catch (error) {
    console.error('[calls/outbound] error:', error);
    return NextResponse.json({ error: 'Failed to place the call' }, { status: 500 });
  }
}
