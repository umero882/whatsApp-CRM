import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/whatsapp/encryption';

const MASKED = '••••••••••••••••';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('ai_agent_config')
    .select('is_enabled, business_name, system_prompt, max_turns, human_pause_minutes, hasura_url, encrypted_hasura_admin_secret, enabled_tools')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ config: null, error: error.message }, { status: 200 });
  }
  if (!data) return NextResponse.json({ config: null });

  return NextResponse.json({
    config: {
      is_enabled: Boolean(data.is_enabled),
      business_name: data.business_name ?? '',
      system_prompt: data.system_prompt ?? '',
      max_turns: data.max_turns ?? 4,
      human_pause_minutes: data.human_pause_minutes ?? 60,
      hasura_url: data.hasura_url ?? '',
      hasura_admin_secret: data.encrypted_hasura_admin_secret ? MASKED : '',
      enabled_tools: Array.isArray(data.enabled_tools) ? data.enabled_tools : [],
    },
  });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const {
    is_enabled,
    business_name,
    system_prompt,
    max_turns,
    human_pause_minutes,
    hasura_url,
    hasura_admin_secret,
    enabled_tools,
  } = body as {
    is_enabled?: boolean;
    business_name?: string | null;
    system_prompt?: string | null;
    max_turns?: number;
    human_pause_minutes?: number;
    hasura_url?: string | null;
    hasura_admin_secret?: string | null;
    enabled_tools?: string[];
  };

  if (typeof max_turns === 'number' && (max_turns < 1 || max_turns > 12)) {
    return NextResponse.json({ error: 'max_turns must be between 1 and 12' }, { status: 400 });
  }
  if (typeof human_pause_minutes === 'number' && human_pause_minutes < 0) {
    return NextResponse.json({ error: 'human_pause_minutes must be >= 0' }, { status: 400 });
  }

  const hasNewSecret =
    typeof hasura_admin_secret === 'string'
    && hasura_admin_secret.trim().length > 0
    && hasura_admin_secret !== MASKED;

  let encryptedSecret: string | null | undefined = undefined; // undefined = leave unchanged
  if (hasNewSecret) {
    try {
      encryptedSecret = encrypt(hasura_admin_secret.trim());
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'encrypt failed' },
        { status: 500 },
      );
    }
  }

  const { data: existing } = await supabase
    .from('ai_agent_config')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();

  const payload: Record<string, unknown> = {
    is_enabled: Boolean(is_enabled),
    business_name: business_name?.trim() || null,
    system_prompt: system_prompt?.trim() || null,
    max_turns: typeof max_turns === 'number' ? max_turns : 4,
    human_pause_minutes: typeof human_pause_minutes === 'number' ? human_pause_minutes : 60,
    hasura_url: hasura_url?.trim() || null,
    enabled_tools: Array.isArray(enabled_tools) ? enabled_tools : [],
    updated_at: new Date().toISOString(),
  };
  if (encryptedSecret !== undefined) {
    payload.encrypted_hasura_admin_secret = encryptedSecret;
  }
  // Explicit clear: if the user cleared the field AND the URL is also empty,
  // null the stored secret. Without this, a stale secret hangs around.
  if (
    !hasNewSecret &&
    typeof hasura_admin_secret === 'string' &&
    hasura_admin_secret.trim() === '' &&
    (!hasura_url || !hasura_url.trim())
  ) {
    payload.encrypted_hasura_admin_secret = null;
  }

  if (existing) {
    const { error } = await supabase
      .from('ai_agent_config')
      .update(payload)
      .eq('user_id', user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase
      .from('ai_agent_config')
      .insert({ user_id: user.id, ...payload });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { error } = await supabase.from('ai_agent_config').delete().eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
