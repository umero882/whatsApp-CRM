import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { makeHasuraClient, type HasuraClient } from './tools/hasura';

export interface MediaConfig {
  openrouter: { apiKey: string; baseUrl?: string; model: string };
  openaiKey: string;
  hasura: HasuraClient;
}

/** Load + decrypt the provider/hasura config needed for media understanding. Null if unconfigured. */
export async function loadMediaConfig(sb: SupabaseClient, userId: string): Promise<MediaConfig | null> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;

  const { data: prov } = await sb.from('ai_provider_config')
    .select('provider, model, base_url, encrypted_api_key').eq('user_id', userId).maybeSingle();
  const { data: agent } = await sb.from('ai_agent_config')
    .select('hasura_url, encrypted_hasura_admin_secret').eq('user_id', userId).maybeSingle();
  if (!prov || !agent?.hasura_url) return null;

  const apiKey = prov.encrypted_api_key ? decrypt(prov.encrypted_api_key) : '';
  const adminSecret = agent.encrypted_hasura_admin_secret ? decrypt(agent.encrypted_hasura_admin_secret) : null;
  return {
    openrouter: { apiKey, baseUrl: prov.base_url ?? undefined, model: prov.model },
    openaiKey,
    hasura: makeHasuraClient(agent.hasura_url, adminSecret),
  };
}
