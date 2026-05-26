import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { makeProvider, type ProviderId } from '@/lib/ai/providers';

const MASKED = '••••••••••••••••';
const PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'openrouter', 'ollama'];

/**
 * GET — returns the saved config with the API key masked. The UI
 * uses this to populate its form on load. Also performs a live ping
 * so the page can show "connected" status without a separate call.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('ai_provider_config')
    .select('provider, model, base_url, encrypted_api_key, system_prompt, is_enabled')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ connected: false, reason: 'db_error', message: error.message }, { status: 200 });
  }
  if (!data) {
    return NextResponse.json({ connected: false, reason: 'no_config' }, { status: 200 });
  }

  let pingResult: { ok: true; model: string } | { ok: false; error: string };
  try {
    const apiKey = data.encrypted_api_key ? decrypt(data.encrypted_api_key) : undefined;
    const provider = makeProvider(data.provider as ProviderId, {
      model: data.model,
      apiKey,
      baseUrl: data.base_url ?? undefined,
    });
    pingResult = await provider.ping();
  } catch (e) {
    pingResult = { ok: false, error: e instanceof Error ? e.message : 'init failed' };
  }

  return NextResponse.json({
    connected: pingResult.ok,
    config: {
      provider: data.provider,
      model: data.model,
      base_url: data.base_url ?? '',
      api_key: data.encrypted_api_key ? MASKED : '',
      system_prompt: data.system_prompt ?? '',
      is_enabled: data.is_enabled,
    },
    message: pingResult.ok ? `Connected to ${data.provider}` : pingResult.error,
  });
}

/**
 * POST — upsert. The API key is encrypted server-side with the same
 * scheme as the WhatsApp token. If the client sends MASKED or empty
 * (unchanged), the existing encrypted value is preserved — same
 * pattern as the WhatsApp verify_token fix in 0d6cc1c.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { provider, model, base_url, api_key, system_prompt, is_enabled } = body as {
    provider?: string;
    model?: string;
    base_url?: string | null;
    api_key?: string | null;
    system_prompt?: string | null;
    is_enabled?: boolean;
  };

  if (!provider || !PROVIDERS.includes(provider as ProviderId)) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  }
  if (!model || typeof model !== 'string' || !model.trim()) {
    return NextResponse.json({ error: 'Model is required' }, { status: 400 });
  }

  const isOllama = provider === 'ollama';
  const hasNewKey = typeof api_key === 'string' && api_key.trim().length > 0 && api_key !== MASKED;
  let encryptedKey: string | null = null;
  if (hasNewKey) {
    try { encryptedKey = encrypt(api_key.trim()); }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'encrypt failed' }, { status: 500 }); }
  }

  // Pre-flight verify against provider so we don't store a bad key.
  try {
    const verifyProvider = makeProvider(provider as ProviderId, {
      model: model.trim(),
      apiKey: hasNewKey ? api_key.trim() : undefined,
      baseUrl: base_url?.trim() || undefined,
    });
    if (!isOllama && !hasNewKey) {
      // Existing row, key unchanged — pull stored key for verification.
      const { data: existing } = await supabase
        .from('ai_provider_config')
        .select('encrypted_api_key')
        .eq('user_id', user.id)
        .maybeSingle();
      if (existing?.encrypted_api_key) {
        const prevKey = decrypt(existing.encrypted_api_key);
        const reverify = makeProvider(provider as ProviderId, {
          model: model.trim(),
          apiKey: prevKey,
          baseUrl: base_url?.trim() || undefined,
        });
        const r = await reverify.ping();
        if (!r.ok) return NextResponse.json({ error: `Provider check failed: ${r.error}` }, { status: 400 });
      } else if (!isOllama) {
        return NextResponse.json({ error: 'API key is required' }, { status: 400 });
      }
    } else {
      const r = await verifyProvider.ping();
      if (!r.ok) return NextResponse.json({ error: `Provider check failed: ${r.error}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Provider check failed' },
      { status: 400 },
    );
  }

  const { data: existing } = await supabase
    .from('ai_provider_config')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();

  const payload: Record<string, unknown> = {
    provider,
    model: model.trim(),
    base_url: base_url?.trim() || null,
    system_prompt: system_prompt?.toString().trim() || null,
    is_enabled: typeof is_enabled === 'boolean' ? is_enabled : true,
    updated_at: new Date().toISOString(),
  };
  if (hasNewKey) payload.encrypted_api_key = encryptedKey;
  else if (isOllama) payload.encrypted_api_key = null;

  if (existing) {
    const { error } = await supabase
      .from('ai_provider_config')
      .update(payload)
      .eq('user_id', user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase
      .from('ai_provider_config')
      .insert({ user_id: user.id, ...payload });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase
    .from('ai_provider_config')
    .delete()
    .eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
