/**
 * Autonomous AI reply agent.
 *
 * Lifecycle, per inbound customer message:
 *   1. Webhook persists the inbound message (sender_type='customer').
 *   2. Webhook calls `runAgent(conversationId)` fire-and-forget.
 *   3. runAgent loads ai_agent_config + ai_provider_config + recent
 *      conversation history.
 *   4. runAgent enters a loop (max N turns from config):
 *        - Call provider.chatWithTools with the registered tool list.
 *        - If LLM returns tool_calls: execute each, append result, loop.
 *        - If LLM returns text: that's the customer-facing reply. Send
 *          it via Meta API, insert into messages with agent_kind='ai',
 *          update conversation.last_message_*, exit.
 *   5. If we hit max_turns without a text answer, fall back to a
 *      polite "let me check with a human" reply and tag the convo.
 *
 * Guards:
 *   - Skip if ai_agent_config.is_enabled = false.
 *   - Skip if conversations.ai_paused_until > now.
 *   - Skip if the most recent message wasn't from the customer (covers
 *     races where a human already replied between webhook and agent).
 *
 * This module uses the SERVICE ROLE Supabase client throughout —
 * the agent runs outside any user session.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { makeProvider, type ProviderId, ProviderError } from './providers';
import type {
  AgentMessage,
  ToolCall,
} from './providers/types';
import {
  ETHIOPIAN_MAIDS_TOOLS,
} from './tools/ethiopian-maids';
import type { ToolHandler, ToolContext } from './tools/registry';
import { findTool, toolsToSpecs } from './tools/registry';

const FALLBACK_REPLY =
  "Thanks for reaching out — let me check on this with a colleague and get back to you shortly.";

interface AgentConfigRow {
  user_id: string;
  is_enabled: boolean;
  business_name: string | null;
  system_prompt: string | null;
  max_turns: number;
  human_pause_minutes: number;
  hasura_url: string | null;
  encrypted_hasura_admin_secret: string | null;
  enabled_tools: string[] | null;
}

interface ProviderConfigRow {
  provider: ProviderId;
  model: string;
  base_url: string | null;
  encrypted_api_key: string | null;
}

interface ConversationRow {
  id: string;
  user_id: string;
  ai_paused_until: string | null;
  contact: { id: string; name: string | null; phone: string }[] | { id: string; name: string | null; phone: string } | null;
}

export type AgentRunResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'replied'; text: string; turns: number; toolsUsed: string[] }
  | { kind: 'escalated'; reason: string }
  | { kind: 'failed'; reason: string };

/**
 * Main entry point. Safe to call fire-and-forget — always resolves,
 * never rejects. Returns a structured result for observability.
 */
export async function runAgent(conversationId: string): Promise<AgentRunResult> {
  try {
    return await runAgentInner(conversationId);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error('[ai-agent] unexpected error:', reason);
    return { kind: 'failed', reason };
  }
}

async function runAgentInner(conversationId: string): Promise<AgentRunResult> {
  const sb = supabaseAdmin();

  // Load conversation (with contact). The `contact` join may return
  // either a single object or an array depending on the inferred
  // relationship cardinality in supabase-js; we normalize below.
  const { data: convRaw, error: convErr } = await sb
    .from('conversations')
    .select('id, user_id, ai_paused_until, contact:contacts(id, name, phone)')
    .eq('id', conversationId)
    .maybeSingle();
  if (convErr) throw new Error(`load conversation: ${convErr.message}`);
  if (!convRaw) return { kind: 'skipped', reason: 'conversation_not_found' };

  const conv = convRaw as ConversationRow;
  const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;
  if (!contact?.phone) return { kind: 'skipped', reason: 'no_contact_phone' };

  // Pause window check.
  if (conv.ai_paused_until && new Date(conv.ai_paused_until).getTime() > Date.now()) {
    return { kind: 'skipped', reason: 'ai_paused' };
  }

  // Agent config.
  const { data: agentCfg, error: agentErr } = await sb
    .from('ai_agent_config')
    .select('user_id, is_enabled, business_name, system_prompt, max_turns, human_pause_minutes, hasura_url, encrypted_hasura_admin_secret, enabled_tools')
    .eq('user_id', conv.user_id)
    .maybeSingle();
  if (agentErr) throw new Error(`load agent config: ${agentErr.message}`);
  if (!agentCfg) return { kind: 'skipped', reason: 'no_agent_config' };
  const agent = agentCfg as AgentConfigRow;
  if (!agent.is_enabled) return { kind: 'skipped', reason: 'agent_disabled' };

  // Provider config (LLM credentials reused from ai_provider_config).
  const { data: provCfg, error: provErr } = await sb
    .from('ai_provider_config')
    .select('provider, model, base_url, encrypted_api_key')
    .eq('user_id', conv.user_id)
    .maybeSingle();
  if (provErr) throw new Error(`load provider config: ${provErr.message}`);
  if (!provCfg) return { kind: 'skipped', reason: 'no_provider_config' };
  const provRow = provCfg as ProviderConfigRow;

  // WhatsApp config (need access token + phone_number_id to send).
  const { data: waCfg, error: waErr } = await sb
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('user_id', conv.user_id)
    .maybeSingle();
  if (waErr) throw new Error(`load wa config: ${waErr.message}`);
  if (!waCfg) return { kind: 'skipped', reason: 'no_whatsapp_config' };

  // Last message must still be from the customer — guards against a
  // race where a human jumped in between webhook persist and our run.
  const { data: lastMsgs, error: lastErr } = await sb
    .from('messages')
    .select('sender_type, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (lastErr) throw new Error(`load last message: ${lastErr.message}`);
  if (!lastMsgs?.length || lastMsgs[0].sender_type !== 'customer') {
    return { kind: 'skipped', reason: 'no_pending_customer_turn' };
  }

  // History for the LLM (oldest first, last 20 messages).
  const { data: histRaw, error: histErr } = await sb
    .from('messages')
    .select('sender_type, content_type, content_text, agent_kind, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (histErr) throw new Error(`load history: ${histErr.message}`);
  const history = [...(histRaw ?? [])].reverse();

  // Build the agent runtime context.
  const accessToken = decrypt(waCfg.access_token);
  const apiKey = provRow.encrypted_api_key ? decrypt(provRow.encrypted_api_key) : undefined;
  const hasuraAdminSecret = agent.encrypted_hasura_admin_secret
    ? decrypt(agent.encrypted_hasura_admin_secret)
    : null;

  const provider = makeProvider(provRow.provider, {
    model: provRow.model,
    apiKey,
    baseUrl: provRow.base_url ?? undefined,
  });

  const toolCtx: ToolContext = {
    supabase: sb,
    userId: conv.user_id,
    conversationId: conv.id,
    contactPhone: contact.phone,
    hasuraUrl: agent.hasura_url,
    hasuraAdminSecret,
  };

  const allowedTools = filterTools(ETHIOPIAN_MAIDS_TOOLS, agent.enabled_tools);
  const toolSpecs = toolsToSpecs(allowedTools);

  // Compose the system prompt: user persona + format/tool directive
  // (server-controlled — can't be overridden by user prompt edits).
  const persona = (agent.system_prompt ?? '').trim() || defaultPersona(agent.business_name);
  const directive = buildAgentDirective(allowedTools);
  const systemPrompt = `${persona}\n\n${directive}`;

  // Build initial messages: system + history transcript + final user nudge.
  const messages: AgentMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const m of history) {
    if (m.sender_type === 'customer') {
      messages.push({ role: 'user', content: stringifyHistoryMessage(m) });
    } else if (m.sender_type === 'agent') {
      messages.push({ role: 'assistant', content: stringifyHistoryMessage(m) });
    }
  }

  // Run the loop.
  const toolsUsed: string[] = [];
  for (let turn = 0; turn < agent.max_turns; turn++) {
    let result;
    try {
      result = await provider.chatWithTools({
        messages,
        tools: toolSpecs,
        temperature: 0.3,
        maxTokens: 1024,
      });
    } catch (e) {
      if (e instanceof ProviderError) {
        console.error('[ai-agent] provider failed:', e.message);
        await postAndPersist(sb, waCfg, accessToken, contact, conv.id, FALLBACK_REPLY);
        return { kind: 'failed', reason: `provider: ${e.message}` };
      }
      throw e;
    }

    if (result.kind === 'text') {
      await postAndPersist(sb, waCfg, accessToken, contact, conv.id, result.text);
      const escalated = toolsUsed.includes('escalate_to_human');
      return escalated
        ? { kind: 'escalated', reason: 'escalate_to_human tool used' }
        : { kind: 'replied', text: result.text, turns: turn + 1, toolsUsed };
    }

    // Tool calls — execute each, append assistant turn + tool results,
    // then loop. Run sequentially (V1) for predictability.
    messages.push({
      role: 'assistant',
      content: result.rawAssistantText ?? null,
      tool_calls: result.calls,
    });

    for (const call of result.calls) {
      toolsUsed.push(call.name);
      const tool = findTool(allowedTools, call.name);
      let resultJson: unknown;
      try {
        if (!tool) {
          resultJson = { error: `Unknown tool: ${call.name}. Available: ${allowedTools.map((t) => t.name).join(', ')}` };
        } else {
          resultJson = await tool.handler(call.arguments, toolCtx);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[ai-agent] tool failed:', call.name, msg);
        resultJson = { error: msg };
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: safeJsonString(resultJson),
      });
    }
  }

  // Loop budget exhausted — send fallback and tag for human.
  console.warn('[ai-agent] max_turns reached without final reply');
  await postAndPersist(sb, waCfg, accessToken, contact, conv.id, FALLBACK_REPLY);
  return { kind: 'failed', reason: 'max_turns_exceeded' };
}

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------

function stringifyHistoryMessage(m: {
  content_type?: string;
  content_text?: string | null;
}): string {
  const text = (m.content_text ?? '').trim();
  if (text) return text;
  return `[${m.content_type ?? 'message'}]`;
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'unserializable tool result' });
  }
}

function filterTools(all: ToolHandler[], allowList: string[] | null): ToolHandler[] {
  if (!allowList || allowList.length === 0) return all;
  return all.filter((t) => allowList.includes(t.name));
}

function defaultPersona(businessName: string | null): string {
  const name = businessName?.trim() || 'this business';
  return `You are the WhatsApp customer-service agent for ${name}.
Speak warmly, in 1-3 short sentences per reply, matching the customer's language.
Acknowledge before you offer or sell. Never invent prices, candidates, or
availability — call a tool first.`;
}

function buildAgentDirective(tools: ToolHandler[]): string {
  return `## OPERATING RULES — IMPORTANT
- You speak directly to the customer on WhatsApp. Whatever final text you produce IS the message they will receive. Do not include "Sure, I can help" preamble. Speak like a human.
- Reply length: 1-3 short sentences. Use line breaks sparingly. No markdown formatting — WhatsApp does not render it well. Use plain text only.
- Match the customer's language (English, Arabic, Amharic, Urdu, etc.).
- BEFORE recommending any candidate, price, or availability claim, you MUST call the relevant tool. Never fabricate.
- If a tool returns no results, say so honestly and offer to broaden criteria or escalate.
- For complaints, refunds, contracts, safety/abuse concerns, or anything beyond your tools' scope: call \`escalate_to_human\` THEN send ONE short reply telling the customer a human agent will be in touch.
- One reply per customer message. Don't send multi-part bursts.
- Available tools: ${tools.map((t) => t.name).join(', ')}.`;
}

/**
 * Send via Meta + persist to DB. Service-role insert (RLS already
 * allows service role on messages — used by the webhook).
 */
async function postAndPersist(
  sb: SupabaseClient,
  waCfg: { phone_number_id: string; access_token: string },
  accessToken: string,
  contact: { id: string; phone: string },
  conversationId: string,
  text: string,
): Promise<void> {
  const phone = sanitizePhoneForMeta(contact.phone);
  let waMessageId = '';
  try {
    const r = await sendTextMessage({
      phoneNumberId: waCfg.phone_number_id,
      accessToken,
      to: phone,
      text,
    });
    waMessageId = r.messageId;
  } catch (e) {
    console.error('[ai-agent] meta send failed:', e instanceof Error ? e.message : e);
    // Persist as failed so the inbox shows the attempt + the error.
    await sb.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      agent_kind: 'ai',
      content_type: 'text',
      content_text: text,
      status: 'failed',
    });
    return;
  }
  await sb.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'agent',
    agent_kind: 'ai',
    content_type: 'text',
    content_text: text,
    message_id: waMessageId,
    status: 'sent',
  });
  await sb
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
}
