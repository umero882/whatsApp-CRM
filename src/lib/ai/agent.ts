/**
 * Autonomous AI reply agent.
 *
 * Stage-aware architecture (see DESIGN.md / roadmap):
 *
 *   GREETING       — first contact or 24h+ silence. No tools. Just welcome.
 *   DISCOVERY      — greeted, intent unclear. No tools. One clarifying Q.
 *   QUALIFICATION  — intent clear (sponsor wants maid), gathering criteria.
 *                    No tools. ONE question per turn.
 *   RECOMMENDATION — enough criteria to search. Tools enabled.
 *   BOOKING        — customer engaging with a candidate. Tools enabled.
 *   CLOSE          — conversation winding down. No tools.
 *
 * The server computes the stage from conversation history and injects
 * it into the system prompt. When the stage forbids tools, the server
 * sends `tools: []` to the provider so the model PHYSICALLY can't
 * call them — much stronger than "don't call tools" in the prompt.
 *
 * This module uses the SERVICE ROLE Supabase client throughout —
 * the agent runs outside any user session.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { filterToolsForChannel, isChannel, sendChannelText, type Channel } from '@/lib/channels/router';
import { makeProvider, type ProviderId, ProviderError } from './providers';
import type {
  AgentMessage,
  ToolCall,
} from './providers/types';
import {
  ETHIOPIAN_MAIDS_TOOLS,
  type AppCardLanguage,
} from './tools/ethiopian-maids';
import { searchKnowledgeBase } from './tools/knowledge-base';
import type { ToolHandler, ToolContext } from './tools/registry';
import { findTool, toolsToSpecs } from './tools/registry';
import { makeHasuraClient } from './tools/hasura';
import { lookupMaidByPhone } from './maid-lookup';

/**
 * Stage names match the documented playbook in the Habiba preset
 * (see src/components/settings/ai-agent-config.tsx). Keep in sync.
 */
type Stage =
  | 'GREETING'
  | 'DISCOVERY'
  | 'QUALIFICATION'
  | 'RECOMMENDATION'
  | 'BOOKING'
  | 'CLOSE';

/** Stages where the model is allowed to call tools. */
const TOOL_STAGES: ReadonlySet<Stage> = new Set(['RECOMMENDATION', 'BOOKING']);

/** Every tool the agent can use: marketplace tools + the knowledge base. */
const AGENT_TOOLS: ToolHandler[] = [...ETHIOPIAN_MAIDS_TOOLS, searchKnowledgeBase];

/** Tools that stay available in every stage, even tool-gated ones. */
const ALL_STAGE_TOOLS: ReadonlySet<string> = new Set([
  'send_app_download_card',
  'reply_with_choices',
  // Policy/process questions ("how do visas work?") arrive at ANY
  // stage — knowledge lookups must never be stage-gated.
  'search_knowledge_base',
  // The agent must be able to hand off to a human at ANY stage —
  // including first contact — when it genuinely cannot resolve the
  // issue (refunds/account changes, safety/legal, angry customer, etc).
  'escalate_to_human',
]);

/**
 * Tools whose success means the customer-facing message for this turn
 * has ALREADY been delivered by the tool itself — an empty final text
 * from the model is the correct outcome, not a failure to retry.
 */
const SELF_DELIVERING_TOOLS: ReadonlySet<string> = new Set(['reply_with_choices']);

/** 24h gap = treat as a fresh conversation. */
const RETURN_GAP_MS = 24 * 60 * 60 * 1000;

/**
 * Admin WhatsApp number (digits only) that receives escalation forwards.
 * Override with ESCALATION_WHATSAPP_NUMBER in .env.local.
 */
const DEFAULT_ESCALATION_PHONE = '971588767821';

/**
 * Ethiopian Maids mobile app — the registration/browsing funnel.
 * Exported so the shipped copy can be asserted on directly in tests
 * (see agent.test.ts) rather than duplicating the string there.
 */
export const APP_INFO_BLOCK = `═══ ETHIOPIAN MAIDS APP (registration happens HERE, not in chat) ═══
• Android: live on Google Play. • iPhone: live on the App Store.
Registration, profile creation, browsing candidates, and applying for jobs
all happen in the app. NEVER collect registration details over chat.
When directing someone to the app, call send_app_download_card (available
in every stage). Pass platform ONLY if the customer already told you which
phone they have — 'ios' for iPhone/iOS/App Store, 'android' for
Android/Samsung/Google Play. If they haven't said, OMIT platform: BOTH store
cards are sent and the customer taps the one for their phone. Do NOT guess
and do NOT ask which phone — omitting is always correct. You MUST actually
CALL the tool — never just say "tap the button above" without calling it, or
no card appears. NEVER paste the store URL as plain text: customers fear
scam links and won't tap them.`;

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
  channel: string | null;
  ai_paused_until: string | null;
  contact:
    | { id: string; name: string | null; phone: string; external_id: string | null }[]
    | { id: string; name: string | null; phone: string; external_id: string | null }
    | null;
}

/**
 * Resolve the outbound destination for a channel from the contact row.
 * WhatsApp (and every other phone-based channel) sends to `phone`;
 * email sends to the contact's `external_id` (the email address).
 * Pure — exported for tests (see agent-email.test.ts).
 */
export function resolveChannelDestination(
  channel: string,
  contact: { phone: string | null; external_id: string | null },
): string {
  return channel === 'email' ? (contact.external_id ?? '') : (contact.phone ?? '');
}

export interface HistoryRow {
  sender_type: 'customer' | 'agent';
  content_type: string;
  content_text: string | null;
  ai_media_summary?: string | null;
  agent_kind?: 'human' | 'ai' | null;
  created_at: string;
}

export type AgentRunResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'replied'; text: string; stage: Stage; turns: number; toolsUsed: string[] }
  | { kind: 'escalated'; reason: string }
  | { kind: 'failed'; reason: string };

/**
 * Main entry. Fire-and-forget safe — always resolves.
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

  // ─── Load conversation + contact ────────────────────────────────────
  const { data: convRaw, error: convErr } = await sb
    .from('conversations')
    .select('id, user_id, channel, ai_paused_until, contact:contacts(id, name, phone, external_id)')
    .eq('id', conversationId)
    .maybeSingle();
  if (convErr) throw new Error(`load conversation: ${convErr.message}`);
  if (!convRaw) return { kind: 'skipped', reason: 'conversation_not_found' };
  const conv = convRaw as ConversationRow;
  const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;

  // Which platform this thread lives on. Pre-migration rows and the
  // WhatsApp webhook both resolve to 'whatsapp'.
  const channel: Channel = isChannel(conv.channel) ? conv.channel : 'whatsapp';

  const destination = contact ? resolveChannelDestination(channel, contact) : '';
  if (!contact || !destination) return { kind: 'skipped', reason: 'no_contact_destination' };

  if (conv.ai_paused_until && new Date(conv.ai_paused_until).getTime() > Date.now()) {
    return { kind: 'skipped', reason: 'ai_paused' };
  }

  // ─── Load agent + provider + WhatsApp config ────────────────────────
  const { data: agentCfg, error: agentErr } = await sb
    .from('ai_agent_config')
    .select('user_id, is_enabled, business_name, system_prompt, max_turns, human_pause_minutes, hasura_url, encrypted_hasura_admin_secret, enabled_tools')
    .eq('user_id', conv.user_id)
    .maybeSingle();
  if (agentErr) throw new Error(`load agent config: ${agentErr.message}`);
  if (!agentCfg) return { kind: 'skipped', reason: 'no_agent_config' };
  const agent = agentCfg as AgentConfigRow;
  if (!agent.is_enabled) return { kind: 'skipped', reason: 'agent_disabled' };

  const { data: provCfg, error: provErr } = await sb
    .from('ai_provider_config')
    .select('provider, model, base_url, encrypted_api_key')
    .eq('user_id', conv.user_id)
    .maybeSingle();
  if (provErr) throw new Error(`load provider config: ${provErr.message}`);
  if (!provCfg) return { kind: 'skipped', reason: 'no_provider_config' };
  const provRow = provCfg as ProviderConfigRow;

  const { data: waCfg, error: waErr } = await sb
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('user_id', conv.user_id)
    .maybeSingle();
  if (waErr) throw new Error(`load wa config: ${waErr.message}`);
  if (!waCfg) return { kind: 'skipped', reason: 'no_whatsapp_config' };

  // ─── Load history (last 20) ─────────────────────────────────────────
  const { data: histRaw, error: histErr } = await sb
    .from('messages')
    .select('sender_type, content_type, content_text, ai_media_summary, agent_kind, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (histErr) throw new Error(`load history: ${histErr.message}`);
  const history = [...(histRaw ?? [])].reverse() as HistoryRow[];

  // Race guard: most recent message must still be from the customer.
  // (Possible the customer-side msg arrived, our webhook fired runAgent,
  // and a human jumped in via the inbox before we got here.)
  const last = history[history.length - 1];
  if (!last || last.sender_type !== 'customer') {
    return { kind: 'skipped', reason: 'no_pending_customer_turn' };
  }

  // ─── Stage + context ────────────────────────────────────────────────
  const intent = detectIntent(history);
  const stage = detectStage(history, intent);
  const customerContext = buildCustomerContext(contact, history);
  const language = detectLanguage(last.content_text ?? '');
  const allowTools = TOOL_STAGES.has(stage);

  // ─── Provider + tools ───────────────────────────────────────────────
  const accessToken = decrypt(waCfg.access_token);
  const apiKey = provRow.encrypted_api_key ? decrypt(provRow.encrypted_api_key) : undefined;
  const hasuraAdminSecret = agent.encrypted_hasura_admin_secret
    ? decrypt(agent.encrypted_hasura_admin_secret)
    : null;

  // Passport-on-file check — job seekers only. Non-fatal: a lookup
  // failure just means we don't have the signal this turn, not a
  // reason to fail the whole reply.
  let maidPassportOnFile: boolean | null = null;
  if (intent === 'job_seeker' && agent.hasura_url) {
    try {
      const lookup = await lookupMaidByPhone(
        makeHasuraClient(agent.hasura_url, hasuraAdminSecret), contact.phone);
      if (lookup.status === 'match') maidPassportOnFile = lookup.passportOnFile ?? false;
    } catch {
      /* non-fatal */
    }
  }

  const provider = makeProvider(provRow.provider, {
    model: provRow.model,
    apiKey,
    baseUrl: provRow.base_url ?? undefined,
  });

  const toolCtx: ToolContext = {
    supabase: sb,
    userId: conv.user_id,
    conversationId: conv.id,
    channel,
    contactPhone: contact.phone,
    contactName: contact.name ?? null,
    escalationPhone: process.env.ESCALATION_WHATSAPP_NUMBER || DEFAULT_ESCALATION_PHONE,
    hasuraUrl: agent.hasura_url,
    hasuraAdminSecret,
    whatsapp: {
      phoneNumberId: waCfg.phone_number_id,
      accessToken,
    },
  };

  const allowedTools = filterTools(AGENT_TOOLS, agent.enabled_tools);
  // STRONG GATE: when stage forbids tools, the model literally can't
  // call them. Stronger than relying on the prompt to say "don't".
  // Exception: send_app_download_card stays available in EVERY stage —
  // directing new customers to the app is the primary action in
  // DISCOVERY/QUALIFICATION, exactly where the other tools are gated.
  const stageTools: ToolHandler[] = filterToolsForChannel(
    allowTools ? allowedTools : allowedTools.filter((t) => ALL_STAGE_TOOLS.has(t.name)),
    channel,
  );
  const toolSpecs = toolsToSpecs(stageTools);

  // ─── Compose system prompt ──────────────────────────────────────────
  const persona = (agent.system_prompt ?? '').trim() || defaultPersona(agent.business_name);
  const runtimeBlock = buildRuntimeBlock(stage, intent, language, customerContext, stageTools, allowTools, maidPassportOnFile, channel);
  const directive = OPERATING_DIRECTIVE;
  // APP_INFO_BLOCK is injected server-side (not only in the editable
  // persona) so the app-funnel policy survives any custom prompt.
  const systemPrompt = [persona, APP_INFO_BLOCK, runtimeBlock, directive].join('\n\n');

  console.log('[ai-agent] start convo=%s stage=%s intent=%s lang=%s tools=%d ctx={returning:%s,name:%s}',
    conv.id, stage, intent, language, stageTools.length, customerContext.isReturning, customerContext.name ?? '?');

  // ─── Messages ───────────────────────────────────────────────────────
  const messages: AgentMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const m of history) {
    if (m.sender_type === 'customer') {
      messages.push({ role: 'user', content: stringifyHistoryMessage(m) });
    } else if (m.sender_type === 'agent') {
      messages.push({ role: 'assistant', content: stringifyHistoryMessage(m) });
    }
  }

  const toolsUsed: string[] = [];

  // ─── Deterministic app card ─────────────────────────────────────────
  // Policy, not a judgement call: a customer who has already said what
  // they want gets the card NOW, on this turn. Sending it here (rather
  // than leaving it to the model) is what makes it survive the triage
  // question — reply_with_choices ends the turn, so a card the model
  // "would have sent next" never arrives. See shouldForceAppCard.
  let preSentCard = false;
  if (shouldForceAppCard(history, intent, last.content_text ?? '')) {
    const cardTool = findTool(stageTools, 'send_app_download_card');
    if (cardTool) {
      try {
        const r = (await cardTool.handler(
          { language: CARD_LANG[language] }, toolCtx,
        )) as { ok?: boolean };
        if (r?.ok) {
          preSentCard = true;
          toolsUsed.push('send_app_download_card');
          console.log('[ai-agent] app card sent server-side (stage=%s intent=%s)', stage, intent);
        } else {
          console.warn('[ai-agent] forced card not delivered:', safeJsonString(r).slice(0, 160));
        }
      } catch (e) {
        console.warn('[ai-agent] forced card send failed:', e instanceof Error ? e.message : e);
      }
    }
  }
  if (preSentCard) {
    // The card is already on screen. Everything left is ONE sentence
    // beside it — no re-send, no follow-up question that would compete
    // with the card for the customer's next action.
    messages.push({
      role: 'user',
      content:
        '[SYSTEM] The official app download card has ALREADY been delivered to this customer '
        + 'in this turn. Do NOT call send_app_download_card and do NOT call reply_with_choices. '
        + 'Reply in plain text with ONE short warm sentence that names the business and points at '
        + 'the card (e.g. "Welcome to Ethiopian Maids 🌸 Tap the button above to get our official '
        + 'app — you can register and browse there."). Do NOT paste any link and do NOT ask a question.',
    });
  }

  // ─── Loop ───────────────────────────────────────────────────────────
  // Set once a SELF_DELIVERING tool has successfully put this turn's
  // customer-facing message in the chat. From that point on, NOTHING
  // else may be sent — no holding lines, no extra model text.
  let selfDelivered = false;
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
        if (selfDelivered) {
          // The customer already has the tappable question — a holding
          // line on top would read as a confusing second message.
          return { kind: 'replied', text: '[interactive choices]', stage, turns: turn + 1, toolsUsed };
        }
        // The card is already on screen: point at it instead of the
        // generic holding line, which would read as a non-sequitur.
        await postAndPersist(sb, waCfg, accessToken, contact, conv.id,
          preSentCard ? cardPointerLine(language) : stageHoldingReply(stage, language),
          channel, destination);
        if (preSentCard) {
          return { kind: 'replied', text: cardPointerLine(language), stage, turns: turn + 1, toolsUsed };
        }
        await logAgentFailure(sb, conv, stage, intent, `provider: ${e.message}`);
        return { kind: 'failed', reason: `provider: ${e.message}` };
      }
      throw e;
    }

    if (result.kind === 'text') {
      let text = result.text.trim();
      // Deterministic guard: small models (seen with gpt-4o-mini)
      // sometimes NARRATE the card tool — "(send_app_download_card)" —
      // instead of calling it. If the final text references the tool,
      // send the card for real and strip the reference so the customer
      // never sees internal tool names.
      const narration = stripCardNarration(text);
      if (narration.mentioned) {
        text = narration.cleaned || cardPointerLine(language);
        if (!toolsUsed.includes('send_app_download_card')) {
          const cardTool = findTool(allowedTools, 'send_app_download_card');
          if (cardTool) {
            try {
              await cardTool.handler({ language: CARD_LANG[language] }, toolCtx);
              toolsUsed.push('send_app_download_card');
              console.warn('[ai-agent] model narrated send_app_download_card — server sent the card itself');
            } catch (e) {
              console.warn('[ai-agent] narration-guard card send failed:', e instanceof Error ? e.message : e);
            }
          }
        }
      }
      if (!text) {
        // Empty content with no tool calls — extremely rare but seen
        // when models go offline mid-response. Retry once with a
        // forceful instruction; if that also fails, send the stage-
        // appropriate holding line.
        console.warn('[ai-agent] empty text, retrying once');
        messages.push({ role: 'assistant', content: '' });
        messages.push({
          role: 'user',
          content: 'Reply now in plain text. One short sentence. Do not call a tool.',
        });
        continue;
      }
      // Deterministic guard (same philosophy as stripCardNarration):
      // models sometimes WRITE the answer options as a text list
      // ("▸ Childcare\n▸ Cooking") instead of calling reply_with_choices.
      // Detect that shape and send real tappable options instead.
      if (!toolsUsed.includes('reply_with_choices')) {
        const extracted = extractChoicesFromText(text);
        const choicesTool = extracted ? findTool(stageTools, 'reply_with_choices') : undefined;
        if (extracted && choicesTool) {
          try {
            const r = (await choicesTool.handler(
              { body_text: extracted.body, options: extracted.options }, toolCtx,
            )) as { ok?: boolean };
            if (r?.ok) {
              toolsUsed.push('reply_with_choices');
              console.warn('[ai-agent] model wrote options as text — server sent tappable choices instead');
              return { kind: 'replied', text: `[interactive choices] ${extracted.body}`, stage, turns: turn + 1, toolsUsed };
            }
          } catch (e) {
            console.warn('[ai-agent] choices guard failed, sending plain text:', e instanceof Error ? e.message : e);
          }
        }
      }
      console.log('[ai-agent] turn', turn + 1, 'reply:', text.slice(0, 120));
      await postAndPersist(sb, waCfg, accessToken, contact, conv.id, text, channel, destination);
      const escalated = toolsUsed.includes('escalate_to_human');
      return escalated
        ? { kind: 'escalated', reason: 'escalate_to_human tool used' }
        : { kind: 'replied', text, stage, turns: turn + 1, toolsUsed };
    }

    // tool_calls — only possible in tool-allowed stages
    console.log(
      '[ai-agent] turn', turn + 1, 'tool_calls:',
      result.calls.map((c) => `${c.name}(${Object.keys(c.arguments).join(',')})`).join(' '),
    );
    messages.push({
      role: 'assistant',
      content: result.rawAssistantText ?? null,
      tool_calls: result.calls,
    });
    for (const call of result.calls) {
      toolsUsed.push(call.name);
      const tool = findTool(stageTools, call.name);
      let resultJson: unknown;
      try {
        if (!tool) {
          resultJson = {
            error: `Tool "${call.name}" is not available in stage ${stage}. Reply in plain text instead.`,
          };
        } else if (preSentCard && call.name === 'send_app_download_card') {
          // Already delivered above — a second card in the same turn is
          // a duplicate message to the customer, not a retry.
          resultJson = {
            ok: true,
            note: 'The card was already sent this turn. Reply with ONE short sentence pointing at it.',
          };
        } else {
          resultJson = await tool.handler(call.arguments, toolCtx);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[ai-agent] tool failed:', call.name, msg);
        resultJson = { error: msg };
      }
      const summary = safeJsonString(resultJson).slice(0, 200);
      console.log('[ai-agent]   →', call.name, 'result:', summary);
      if (
        SELF_DELIVERING_TOOLS.has(call.name) &&
        resultJson && typeof resultJson === 'object' &&
        (resultJson as { ok?: unknown }).ok === true
      ) {
        selfDelivered = true;
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: safeJsonString(resultJson),
      });
    }

    // A self-delivering tool succeeded — the customer already has this
    // turn's message. End the run HERE: another provider round-trip can
    // only add cost and failure modes (a stray trailing sentence, or a
    // holding line if the provider call errors).
    if (selfDelivered) {
      console.log('[ai-agent] turn complete via self-delivering tool');
      return { kind: 'replied', text: '[interactive choices]', stage, turns: turn + 1, toolsUsed };
    }
  }

  // Loop exhausted — stage-aware holding reply
  console.warn('[ai-agent] max_turns reached without final reply');
  if (selfDelivered) {
    return { kind: 'replied', text: '[interactive choices]', stage, turns: agent.max_turns, toolsUsed };
  }
  await postAndPersist(sb, waCfg, accessToken, contact, conv.id,
    preSentCard ? cardPointerLine(language) : stageHoldingReply(stage, language),
    channel, destination);
  if (preSentCard) {
    return { kind: 'replied', text: cardPointerLine(language), stage, turns: agent.max_turns, toolsUsed };
  }
  await logAgentFailure(sb, conv, stage, intent, 'max_turns_exceeded');
  return { kind: 'failed', reason: 'max_turns_exceeded' };
}

// ════════════════════════════════════════════════════════════════════
// Intent classification — sponsor vs job_seeker
// ════════════════════════════════════════════════════════════════════

/**
 * Who are we talking to?
 *
 *   sponsor      — wants to HIRE a maid (family, individual, employer)
 *   job_seeker   — IS a maid looking for work (the maid herself, or a
 *                  recruiter on her behalf)
 *   unknown      — no clear signal yet; agent must classify by asking
 *
 * Determined cheaply from history keywords. Once classified, the
 * server "sticks" with the intent for the rest of the conversation —
 * later turns that don't mention either side don't reset it.
 */
export type Intent = 'sponsor' | 'job_seeker' | 'unknown';

const SPONSOR_PATTERNS = [
  /\b(i\s*(need|want|am\s*looking\s*for|require)\s*(a\s*)?(maid|nanny|housekeeper|domestic|helper|cook|elderly\s*care|cleaner|driver|nurse|caregiver|sirvienta|sirvient|خادم|مربية))\b/i,
  /\b(hire|hiring|to\s*hire|want\s*to\s*hire|looking\s*to\s*hire)\b/i,
  /\b(for\s*my\s*(kids|children|baby|family|parents|home|house))\b/i,
  /\b(احتاج|ابغى|اريد|اطلب|ابحث\s*عن).*(خادم|مربية|عاملة|سائق|ممرضة)/i,
];

const JOB_SEEKER_PATTERNS = [
  /\b(i\s*(need|want|am\s*looking\s*for)\s*(a\s*)?(job|work|position|placement|employment))\b/i,
  /\b(looking\s*for\s*(a\s*)?(job|work|position|placement))\b/i,
  /\b(i\s*am\s*a\s*(maid|nanny|housekeeper|cook|helper|domestic\s*worker))\b/i,
  /\b(can\s*i\s*work|how\s*can\s*i\s*apply|i\s*want\s*to\s*work|apply\s*for\s*work)\b/i,
  /\b(my\s*experience|years\s*of\s*experience)\b/i,
  /\b(احتاج|ابغى|اريد|ابحث\s*عن|اطلب).*(عمل|شغل|وظيفة|وظائف)/i,
  /\b(انا\s*خادمة|مربية\s*اطفال|ابحث\s*عن\s*عمل)/i,
];

function detectIntent(history: HistoryRow[]): Intent {
  // Walk the customer messages in REVERSE (most recent first) so the
  // latest signal wins — but stop at the first definitive classification
  // to avoid re-flipping on later neutral messages.
  const customerMsgs = history.filter((m) => m.sender_type === 'customer');
  for (let i = customerMsgs.length - 1; i >= 0; i--) {
    const text = (customerMsgs[i].content_text ?? '').toLowerCase().trim();
    if (!text) continue;
    if (SPONSOR_PATTERNS.some((p) => p.test(text))) return 'sponsor';
    if (JOB_SEEKER_PATTERNS.some((p) => p.test(text))) return 'job_seeker';
  }
  return 'unknown';
}

// ════════════════════════════════════════════════════════════════════
// Stage detection
// ════════════════════════════════════════════════════════════════════

/**
 * Conservative classifier — no LLM call, just pattern + history shape.
 *
 * Intent-aware: a sponsor needs to be qualified differently than a
 * job-seeker, and the threshold for "we know enough to recommend" is
 * different. Most importantly, we don't promote to RECOMMENDATION
 * (and unlock tools) until we've actually gathered enough criteria,
 * so the model can't search/list with empty filters.
 */
function detectStage(history: HistoryRow[], intent: Intent): Stage {
  if (history.length === 0) return 'GREETING';

  const last = history[history.length - 1];
  const lastText = (last?.content_text ?? '').trim();
  const lastTextLower = lastText.toLowerCase();

  const outboundCount = history.filter((m) => m.sender_type === 'agent').length;
  const customerTexts = history
    .filter((m) => m.sender_type === 'customer')
    .map((m) => (m.content_text ?? '').trim())
    .filter(Boolean);

  // Fresh conversation if it's been 24h+ since last agent reply.
  const lastAgent = [...history].reverse().find((m) => m.sender_type === 'agent');
  if (lastAgent) {
    const gap = Date.now() - new Date(lastAgent.created_at).getTime();
    if (gap > RETURN_GAP_MS) return 'GREETING';
  } else {
    // No agent reply ever — we haven't greeted yet.
    return 'GREETING';
  }

  // CLOSE
  if (/^(thanks|thank you|ok|okay|bye|goodbye|cheers|👍|🙏|شكر|متشكر|መልካም)\b/i.test(lastTextLower)) {
    return 'CLOSE';
  }

  // GREETING (only if we haven't already greeted)
  const greetingPattern = /^(hi|hello|hey|salam|سلام|hola|hii|good (morning|afternoon|evening)|asalam|hi there|👋)/i;
  if (outboundCount === 0 && (greetingPattern.test(lastTextLower) || lastText.length <= 12)) {
    return 'GREETING';
  }
  if (outboundCount === 0) return 'GREETING';

  // BOOKING — explicit transactional cues (only meaningful AFTER we've
  // gathered some criteria, hence the customerTexts.length guard)
  if (
    customerTexts.length >= 2 &&
    /\b(book|interview|schedule|how much|price|fee|cost|details|profile|photo)\b/i.test(lastTextLower)
  ) {
    return 'BOOKING';
  }

  // Intent-aware: how much do we need before RECOMMENDATION?
  // Heuristic: enough info ≈ 2+ customer turns AND specific criteria
  // mentioned. Otherwise stay in QUALIFICATION so tools remain gated.
  const hasSponsorCriteria = /\b(dubai|abu\s*dhabi|sharjah|ajman|fujairah|ras\s*al\s*khaimah|umm\s*al\s*quwain|live[\s-]*in|live[\s-]*out|cook|cleaning|childcare|elderly|nanny|babys|housekeep|housekeeper|driver|driving|nurse|nursing)\b/i.test(
    customerTexts.join(' '),
  );
  const hasJobSeekerCriteria = /\b(ethiopia|addis|kenya|uganda|dubai|uae|saudi|abu\s*dhabi|kuwait|qatar|bahrain|oman|years?\s*(of\s*)?experience|childcare|cook|cleaning|elderly)\b/i.test(
    customerTexts.join(' '),
  );

  if (intent === 'sponsor' && customerTexts.length >= 2 && hasSponsorCriteria) {
    return 'RECOMMENDATION';
  }
  if (intent === 'job_seeker' && customerTexts.length >= 2 && hasJobSeekerCriteria) {
    return 'RECOMMENDATION';
  }

  // Already greeted; intent unknown or criteria not yet gathered.
  // The DISCOVERY stage is for INTENT discovery; once intent is known,
  // we move to QUALIFICATION (where tools are still gated).
  if (intent === 'unknown') return 'DISCOVERY';
  return 'QUALIFICATION';
}

// ════════════════════════════════════════════════════════════════════
// Customer context
// ════════════════════════════════════════════════════════════════════

interface CustomerContext {
  name: string | null;
  isReturning: boolean;
  /** How many turns the customer has had with us, ever (within history window). */
  customerTurns: number;
}

function buildCustomerContext(
  contact: { name: string | null; phone: string },
  history: HistoryRow[],
): CustomerContext {
  const customerTurns = history.filter((m) => m.sender_type === 'customer').length;
  // "Returning" = there's at least one prior agent reply in the window
  // AND the last agent reply was more than 1 hour ago (i.e. this is a
  // new session, not just continuation of an active chat).
  const agentReplies = history.filter((m) => m.sender_type === 'agent');
  const lastAgent = agentReplies[agentReplies.length - 1];
  const oneHour = 60 * 60 * 1000;
  const isReturning = !!lastAgent
    && (Date.now() - new Date(lastAgent.created_at).getTime()) > oneHour
    && agentReplies.length >= 1;
  return {
    name: contact.name?.trim() || null,
    isReturning,
    customerTurns,
  };
}

// ════════════════════════════════════════════════════════════════════
// Language detection (lightweight, no extra deps)
// ════════════════════════════════════════════════════════════════════

export type Lang = 'English' | 'Arabic' | 'Amharic' | 'Urdu' | 'Hindi';

/** Conversation language → app-card copy language. */
export const CARD_LANG: Record<Lang, AppCardLanguage> = {
  English: 'en',
  Arabic: 'ar',
  Amharic: 'am',
  Urdu: 'ar',
  Hindi: 'en',
};

/**
 * Detect a model NARRATING the app-card tool in customer-facing text
 * (e.g. "Tap the button below 🌸 (send_app_download_card)") and strip
 * every reference. Pure — exported for tests.
 */
/**
 * A reply that POINTS AT a download card the model never actually sent —
 * either by writing the tool name ("(send_app_download_card)") or, more
 * commonly, in plain language ("tap the button above to get our app"). Both
 * mean "a card should be on screen"; if none was sent this turn, the caller
 * sends it for real. Missing the plain-language form left customers with the
 * pointer sentence and no card at all (production incident 2026-07-17).
 *
 * The phrases are scoped to app-download pointing ("tap the button above",
 * "download our/the app", "get our official app") so an unrelated mention of
 * an app does not trigger a spurious card.
 */
const CARD_POINTER_RE =
  /send_app_download_card|tap the (?:button|link) (?:above|below)|(?:get|download|install)[^.!?\n]*\bour\b[^.!?\n]*\bapp\b|download (?:the|our) (?:official )?app/i;

export function stripCardNarration(text: string): { cleaned: string; mentioned: boolean } {
  if (!CARD_POINTER_RE.test(text)) {
    return { cleaned: text, mentioned: false };
  }
  // Only the literal tool name needs stripping from the visible reply; the
  // natural-language pointer sentence is a fine thing to show the customer.
  const cleaned = text
    .replace(/[([{]?\s*(?:call(?:ing)?\s+)?send_app_download_card\s*(?:\(\s*\))?\s*[)\]}]?/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleaned, mentioned: true };
}

/** Fallback one-liner when the model's whole reply was tool narration. */
function cardPointerLine(lang: Lang): string {
  if (lang === 'Arabic' || lang === 'Urdu') return 'اضغط الزر بالأعلى لتحميل تطبيقنا الرسمي 🌸';
  if (lang === 'Amharic') return 'ኦፊሴላዊ መተግበሪያችንን ለማውረድ ከላይ ያለውን ቁልፍ ይጫኑ 🌸';
  return 'Tap the button above to get our official app 🌸';
}

// ════════════════════════════════════════════════════════════════════
// Deterministic app-card trigger
//
// Production incident 2026-08-22: across 58 conversations the card was
// sent on the FIRST agent reply exactly ZERO times. Three causes
// compounded — GREETING guidance led with "do NOT assume / do NOT ask",
// OPERATING_DIRECTIVE pushes reply_with_choices far harder than the
// card, and reply_with_choices is self-delivering (it ENDS the turn),
// so once the model asked "registered or new?" the card could not ride
// along. ~30% of customers never answered the triage → no card, ever.
//
// The fix is to stop asking the model. When the customer has ALREADY
// told us what they want, the card is not a judgement call — it's
// policy (see OPERATING_DIRECTIVE "REGISTRATION POLICY"). Send it
// server-side and let the model write only the sentence beside it.
// ════════════════════════════════════════════════════════════════════

/**
 * The customer has just identified themselves as NOT-yet-registered —
 * typically by tapping the "I'm new" triage option, but the free-text
 * equivalents are matched too. This is the second place the card used
 * to go missing: the triage answer arrives with no hire/work keyword,
 * so detectIntent stays 'unknown' and the model asks yet another
 * question instead of sending the card.
 */
// NOTE: \b is ASCII-only in JS (\w === [A-Za-z0-9_]), so it never
// matches beside Arabic or Amharic letters. The non-Latin alternatives
// therefore sit OUTSIDE the \b-terminated group — with them inside, the
// Arabic and Amharic branches silently never fire.
const NEW_CUSTOMER_RE =
  /^(?:(?:i['’]?m\s+new|new\s+here|i\s+am\s+new|not\s+registered|no,?\s*(?:i['’]?m\s+)?new|first\s+time)\b|جديد|لست\s+مسجل|አዲስ)/i;

/**
 * Free-text asks that mean "point me at the app" but carry no hire/work
 * keyword, so detectIntent alone would miss them.
 */
const APP_FUNNEL_RE =
  /\b(?:register|registration|sign\s*up|signup|create\s+(?:an\s+)?account|join|download|app\s+link|your\s+app|the\s+app)\b|تسجيل|سجل|التطبيق|ተመዝገብ|መተግበሪያ/i;

/** Has the card already been delivered in this conversation? */
function cardAlreadySent(history: HistoryRow[]): boolean {
  return history.some(
    (m) => m.sender_type === 'agent' && /app download card/i.test(m.content_text ?? ''),
  );
}

/**
 * Should the server send the app card itself this turn, rather than
 * hoping the model calls the tool? True when the card has not been sent
 * yet AND either:
 *   a) this is FIRST CONTACT and the opener already states what they
 *      want (hire / find work / register) — nothing left to triage; or
 *   b) the customer just told us they are new / not registered.
 *
 * Deliberately NOT triggered for an ambiguous opener ("can I get more
 * info?"): those still get the triage question, which is correct.
 * Pure — exported for tests.
 */
export function shouldForceAppCard(
  history: HistoryRow[],
  intent: Intent,
  lastCustomerText: string,
): boolean {
  if (cardAlreadySent(history)) return false;
  const text = lastCustomerText.trim();
  if (NEW_CUSTOMER_RE.test(text)) return true;
  const firstContact = !history.some((m) => m.sender_type === 'agent');
  return firstContact && (intent !== 'unknown' || APP_FUNNEL_RE.test(text));
}

/**
 * Detect a final reply that WRITES fixed answer options as a trailing
 * text list ("What duties?\n▸ Childcare\n▸ Cooking") instead of calling
 * reply_with_choices. Returns the split body + options when the shape
 * is unambiguous, else null. Pure — exported for tests.
 *
 * Deliberately conservative: 2-10 trailing bullet/numbered lines, each
 * ≤30 chars (real option labels are short; prose lists and job/candidate
 * summaries are long), preceded by a body that asks something.
 */
export function extractChoicesFromText(
  text: string,
): { body: string; options: string[] } | null {
  return extractBulletChoices(text) ?? extractProseChoices(text);
}

/** "Question?\n▸ A\n- B\n1. C" — trailing bullet/numbered option lines. */
function extractBulletChoices(text: string): { body: string; options: string[] } | null {
  const lines = text.split('\n').map((l) => l.trim());
  const optRe = /^(?:[-•▸*›‣◦]|\d{1,2}[.)])\s*(.+)$/;
  let i = lines.length - 1;
  while (i >= 0 && !lines[i]) i--;
  const options: string[] = [];
  while (i >= 0) {
    const m = lines[i].match(optRe);
    if (!m) break;
    const value = m[1].trim();
    if (!value || value.length > 30) return null;
    options.unshift(value);
    i--;
  }
  if (options.length < 2 || options.length > 10) return null;
  const body = lines.slice(0, i + 1).join(' ').replace(/\s+/g, ' ').trim();
  if (!body) return null;
  // Body must actually be asking for a pick — guards against stray
  // bullet fragments in informational replies.
  if (!body.includes('?') && !/[:：]$/.test(body)) return null;
  return { body, options };
}

/**
 * "Question? Options include A, B, or C." — the options enumerated in
 * a trailing prose sentence (seen in production with gpt-4o-mini after
 * the bullet form was blocked). Only fires when the enumeration is the
 * LAST sentence and the preceding text contains the actual question.
 */
function extractProseChoices(text: string): { body: string; options: string[] } | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = flat.match(
    /\b(?:(?:the\s+)?options?\s+(?:include|are)|(?:you\s+can\s+)?choose\s+(?:from|between|one\s+of)|pick\s+(?:from|one\s+of))\s*:?\s*([^.?!]+)[.!?]?\s*$/i,
  );
  if (!m) return null;
  const body = flat.slice(0, m.index).trim();
  if (!body.includes('?')) return null;
  const options: string[] = [];
  for (const raw of m[1].split(/\s*,\s*|\s+(?:or|and)\s+/i)) {
    const value = raw.replace(/^(?:or|and)\s+/i, '').trim();
    if (!value) continue;
    if (value.length > 30) return null;
    if (!options.includes(value)) options.push(value);
  }
  if (options.length < 2 || options.length > 10) return null;
  return { body, options };
}

export function detectLanguage(text: string): Lang {
  if (!text) return 'English';
  // Amharic uses Ethiopic script (U+1200–U+137F)
  if (/[ሀ-፿]/.test(text)) return 'Amharic';
  // Devanagari (Hindi) U+0900–U+097F
  if (/[ऀ-ॿ]/.test(text)) return 'Hindi';
  // Urdu uses Arabic script + specific letters (ٹ ڈ ڑ ے ں etc.)
  if (/[ٹڈڑںھہے]/.test(text)) return 'Urdu';
  // Plain Arabic
  if (/[؀-ۿ]/.test(text)) return 'Arabic';
  return 'English';
}

// ════════════════════════════════════════════════════════════════════
// Prompt assembly
// ════════════════════════════════════════════════════════════════════

function defaultPersona(businessName: string | null): string {
  const name = businessName?.trim() || 'this business';
  return `You are the WhatsApp customer-service agent for ${name}.
Your chat is for CUSTOMER SERVICE — helping existing customers with their
issues and questions. Registration and sign-up happen in our mobile app,
never over chat: direct new customers to download the app instead.
Customers can be EITHER sponsors looking to hire a maid OR maids/job-seekers
looking for work — never assume. Read the INTENT GUIDANCE below before
responding.
Speak warmly, in 1-3 short sentences per reply, matching the customer's
language. Acknowledge before you offer or sell. Never invent prices,
candidates, jobs, or availability — call a tool first when one is enabled.`;
}

function buildRuntimeBlock(
  stage: Stage,
  intent: Intent,
  language: Lang,
  ctx: CustomerContext,
  activeTools: ToolHandler[],
  toolsAllowedThisTurn: boolean,
  maidPassportOnFile: boolean | null,
  channel: Channel = 'whatsapp',
): string {
  const toolList = activeTools.map((t) => `${t.name} — ${t.description.split('.')[0]}.`).join('\n  • ');
  const stageGuide = STAGE_GUIDANCE[stage];
  const intentGuide = INTENT_GUIDANCE[intent];
  const customerLine = ctx.name
    ? `Customer name: ${ctx.name}${ctx.isReturning ? ' (returning customer — DO NOT re-greet, continue naturally)' : ''}`
    : (ctx.isReturning ? 'Returning customer (DO NOT re-greet, continue from previous context).' : 'New customer — first contact.');
  const toolsLine = toolsAllowedThisTurn
    ? `Tools available NOW (${activeTools.length}):\n  • ${toolList}`
    : (activeTools.length > 0
      ? `Most tools are DISABLED for this turn (stage ${stage}). ONLY these may be called:\n  • ${toolList}\nAnything else: reply in plain text.`
      : `Tools are DISABLED for this turn (stage ${stage}). Reply in plain text only — do not attempt to call tools.`);
  const passportLine = maidPassportOnFile === false
    ? '\nPASSPORT: This registered maid has NO passport document on file. If the conversation reaches document collection, ask ONCE for a clear photo of her passport. If she already sent it this session, do not ask again. When maidPassportOnFile is true or null, NEVER ask for the passport.\n'
    : '';
  const channelLine = channel === 'whatsapp'
    ? ''
    : `\nCHANNEL: ${channel} — interactive buttons, cards, and download cards are NOT available here. When a question has fixed answers, list them as a short numbered plain-text list and ask the customer to reply with a number or the option name.\n`;
  return `═══ RUNTIME CONTEXT ═══
STAGE: ${stage}
INTENT: ${intent}${channelLine}
LANGUAGE: ${language} (reply in this language)
${customerLine}
Customer turns so far in this conversation: ${ctx.customerTurns}

INTENT GUIDANCE (critical — read first):
${intentGuide}

STAGE GUIDANCE:
${stageGuide}
${passportLine}
${toolsLine}
═══════════════════════`;
}

export const STAGE_GUIDANCE: Record<Stage, string> = {
  GREETING:
    'This is a fresh conversation. FIRST decide which of these two cases you are in.\n'
    + 'CASE A — their message ALREADY says what they want (to hire, to find work, to register, to download the app): call the send_app_download_card TOOL immediately (a REAL tool call — never type its name in your text), then reply with ONE warm sentence that names the business and points at the card. Do NOT ask "are you registered?" first — they already told you what they need, and asking costs us the customer. Do NOT call reply_with_choices in this case.\n'
    + 'CASE B — their message is just a greeting or a vague "can I get more info?": send a warm welcome that names the business. Do NOT assume they want to hire OR to work — you do not know yet. One friendly sentence is plenty.',
  DISCOVERY:
    'You have greeted the customer. Anyone who is NEW, or who wants to register / hire / find work, gets send_app_download_card FIRST — that is the single most useful thing you can do for them, and registration never happens in chat. Only when you genuinely cannot tell whether they are new should you triage: call reply_with_choices with "Are you already registered with us, or new here?" and options like ["Existing customer","I\'m new"] (translate to the conversation language). Never triage twice — if the history already answers it, act on the answer. EXISTING customers or anyone with a service issue → find out what they need, per the INTENT GUIDANCE above. No other tools.',
  QUALIFICATION:
    'You know the customer intent (see INTENT GUIDANCE above). If they are NEW and want to register/hire/find work, call send_app_download_card instead of qualifying in chat. For existing customers, gather the relevant basics with ONE question per turn, skipping what you already know from history. Fixed-answer questions (live-in/live-out, duties, emirate) go through reply_with_choices; open-ended ones (start date, languages) stay plain text. No other tools until you have enough info per the intent guidance.',
  RECOMMENDATION:
    'You have enough info to make a recommendation. Use the right tool for the intent (search_maids for sponsors, list_jobs for job seekers). Present 2-3 results max. Offer the next step.',
  BOOKING:
    'Customer is engaging — interested in a candidate, asking pricing, or ready to apply. Use get_maid_profile / get_pricing for sponsors; for job seekers, take down their details and confirm next steps. Be specific and concrete.',
  CLOSE:
    'Customer is wrapping up. Acknowledge briefly and warmly. Leave the door open for future contact. Do NOT call tools.',
};

const INTENT_GUIDANCE: Record<Intent, string> = {
  sponsor: `Customer is a SPONSOR seeking to HIRE a maid (family, employer, or representative).
IF NEW (not yet registered with us): call send_app_download_card —
registration and browsing candidates happen in the app. You may answer
general questions (fees via get_pricing, how the service works) but do
NOT run the full qualification/recommendation flow for unregistered
customers; the app is the funnel.
IF EXISTING customer (registered, or clearly already working with us):
proceed with the flow below.
Qualification questions to gather (one per turn, skip if already answered):
  1. Which emirate are you in? (reply_with_choices: the 7 emirates)
  2. Live-in or live-out? (reply_with_choices: ["Live-in","Live-out"])
  3. Main duties? (reply_with_choices: ["Childcare","Cooking","Elderly care","General housework"])
  4. When do you need her to start? (plain text — open-ended)
  5. Any language or experience preference? (plain text)

Recommendation flow — TWO TOOLS, not one:
  a) Call search_maids with the criteria you've gathered.
  b) Pick the top 1-3 candidate ids from the result.
  c) Call send_maid_cards({ maid_ids: [...] }) — this sends each maid
     as a photo+caption WhatsApp message (a card). DO NOT skip this
     step; do NOT just list candidates in text.
  d) Your FINAL text reply is ONE short sentence — "Want details on
     any of them? Reply with the name." — NEVER repeat the candidate
     info in text after sending cards (the customer already saw them).

NEVER share full names, IDs, or contact info in text. The cards
already include first name + nationality + experience + skills +
salary range + photo.

Booking flow (when customer says "book interview for X", "I want to
interview Grace", "schedule a call with Maria", etc.):
  1. Look at history — the maid name they mention should be one you
     already showed via send_maid_cards. Use that first name.
  2. If they haven't given a specific date/time, ASK: "When works
     for you? E.g. tomorrow 2pm, today 4pm, in 2 hours."
  3. Once you have a time, call book_interview({
        maid_name: "Grace",
        preferred_datetime: "tomorrow 2pm" (or ISO format),
        duration_minutes: 30
     })
     The server resolves the name to the maid's UUID. You do NOT
     need to call get_maid_profile first.
  4. The tool returns booking_id + meeting_url + scheduled_at. Your
     final reply MUST include the meeting link and confirmed time,
     plus a note that the candidate will be confirmed and reminded.
     Example: "Done — interview with Grace booked for tomorrow at
     2 PM. Join here: https://meet.jit.si/... — we'll confirm with
     Grace and send a reminder before the call."

get_maid_profile is for "tell me more about Grace" (informational),
NOT for booking. Don't call it just to look up an id — book_interview
does that itself.

For pricing: call get_pricing(country: "UAE").`,

  job_seeker: `Customer IS a MAID looking for WORK (or someone applying on her behalf).
Do NOT ask her to hire anyone. Do NOT ask which emirate she wants TO HIRE FROM.
PRIMARY PATH — the app: registration and job applications happen in the
Ethiopian Maids app. Call send_app_download_card (use language "am" for
Amharic speakers) so she gets the official download card, and tell her to
create her profile and apply inside the app. Do NOT collect registration
details (passport, experience, availability) over chat.
You MAY still call list_jobs to show 1-3 matching openings as a taste of
what's available, then point her to the app to register and apply.
Do NOT promise placement. Only use escalate_to_human for real service
issues (complaint, payment, safety, existing application gone wrong) —
NOT as the standard application path anymore.`,

  unknown: `You do NOT yet know if this customer wants to hire a maid (sponsor) or
is looking for work themselves (job seeker) — or whether they are an existing
customer with a service issue. Triage with ONE question at a time, starting with:
  English: "Are you already registered with us, or new here?"
  Arabic:  "هل أنت مسجل لدينا بالفعل، أم جديد؟"
NEW + wants to hire or find work → call send_app_download_card.
EXISTING or has an issue → ask what they need help with and assist.
Do NOT assume one side. Do NOT ask emirate/duties yet.`,
};

const OPERATING_DIRECTIVE = `═══ OPERATING RULES ═══
• You are speaking DIRECTLY to the customer on WhatsApp. Your output IS the message they receive — no preamble like "Sure, I can help".
• Reply length: 1–3 short sentences. Plain text only — WhatsApp does not render markdown.
• ONE WhatsApp message per turn. No multi-part bursts.
• Use the customer's name once you know it. Never "Dear Sir/Madam".
• ONE question per turn at most. Don't interrogate.
• CHOICES ARE TAPPED, NOT TYPED: whenever your question has 2–10 fixed answers (yes/no, registered/new, live-in/live-out, picking a candidate or time), call reply_with_choices (available in every stage) — the customer taps an option instead of typing. The tool message IS your reply: after it succeeds, output an EMPTY final message and never repeat the options as text. NEVER write answer options inside your text — not as bullets, dashes, numbered lines, NOR as a prose sentence like "Options include A, B, or C" — every enumeration of answers is ALWAYS a reply_with_choices call. Open-ended questions (name, city, dates, budgets) stay plain text. EXCEPTION — this rule NEVER outranks the app card: if the customer has already said they want to hire, find work, or register, call send_app_download_card instead of asking them anything. reply_with_choices ENDS your turn, so a question asked now means the card cannot be sent until they reply again — and most never do.
• NEVER invent candidates, prices, availability, or policies. Use the tools when they're enabled.
• KNOWLEDGE: questions about how our service works — visa process, timelines, what fees include, refunds/replacements, medical checks, trial periods, required documents — go through search_knowledge_base FIRST (available in every stage). Answer ONLY from the returned passages; when nothing is found, say you'll confirm with our team. NEVER answer policy from memory.
• NEVER share a maid's full name, passport number, exact location, or phone before a confirmed booking.
• We are a placement MARKETPLACE connecting sponsors, licensed agencies, and household workers for GCC households — primarily Ethiopian candidates plus other African and Asian nationalities common in GCC household work. We serve ALL household staff roles: maids, housekeepers, nannies, cooks, cleaners, elderly-care helpers, drivers, and private nurses. Decline only non-household staffing and non-GCC destinations.
• Fees, replacement, refunds, contract duration, cancellation, sick leave: agreed between SPONSOR and AGENCY under the destination country's domestic-worker rules (the source of truth). NEVER promise such terms on the platform's behalf — answer via search_knowledge_base and advise confirming with the agency in writing.
• REGISTRATION POLICY: sign-up, profile creation, and job applications happen in the Ethiopian Maids app — never over chat. New customers get the official download card via send_app_download_card — NEVER a pasted store URL (customers fear scam links). Chat is for customer service.

ESCALATE (call escalate_to_human) ONLY for: complaints, refunds, contracts, visa/legal specifics, safety concerns, customer is angry, or off-topic after one polite decline. NEVER escalate because a tool errored or because a question is vague — ask back instead.
When you escalate, pass issue_summary with the concrete details — the tool forwards it to our human admin. Then tell the customer their issue has been forwarded and a human will follow up shortly — do NOT promise a specific channel like "on this number" (this agent also serves email).

When in doubt: ask a brief clarifying question, do NOT call a tool, do NOT escalate.`;

// ════════════════════════════════════════════════════════════════════
// Stage-appropriate holding line (replaces the old "let me check with
// a colleague" fallback, which was dishonest and tone-deaf for greetings)
// ════════════════════════════════════════════════════════════════════

function stageHoldingReply(stage: Stage, lang: Lang): string {
  const en: Record<Stage, string> = {
    GREETING: 'Hello! How can I help you today?',
    DISCOVERY: 'Could you tell me a little more about what you’re looking for?',
    QUALIFICATION: 'Could you give me a bit more detail so I can help you better?',
    RECOMMENDATION: 'Let me get one of our team on this — they’ll be in touch shortly.',
    BOOKING: 'Let me get one of our team on this — they’ll be in touch shortly.',
    CLOSE: 'Thanks for reaching out!',
  };
  const ar: Record<Stage, string> = {
    GREETING: 'مرحباً! كيف يمكنني مساعدتك اليوم؟',
    DISCOVERY: 'هل يمكنك إخباري المزيد عن ما تبحث عنه؟',
    QUALIFICATION: 'هل يمكنك إعطائي تفاصيل أكثر حتى أساعدك بشكل أفضل؟',
    RECOMMENDATION: 'سأطلب من أحد أعضاء فريقنا متابعة هذا — سيتواصلون معك قريباً.',
    BOOKING: 'سأطلب من أحد أعضاء فريقنا متابعة هذا — سيتواصلون معك قريباً.',
    CLOSE: 'شكراً لتواصلك معنا!',
  };
  if (lang === 'Arabic' || lang === 'Urdu') return ar[stage];
  return en[stage];
}

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

export function stringifyHistoryMessage(m: HistoryRow): string {
  const text = (m.content_text ?? '').trim();
  if (m.ai_media_summary && m.ai_media_summary.trim()) {
    const label = m.content_type === 'image' ? 'photo' : m.content_type === 'audio' ? 'voice note' : m.content_type;
    return `[${label}] ${m.ai_media_summary.trim()}`;
  }
  // Our own interactive choices messages are persisted as
  // "body\n▸ Option\n▸ Option". Presented raw, models IMITATE that
  // style in plain text instead of calling reply_with_choices — so
  // re-frame them as an explicit tool artifact.
  if (m.sender_type === 'agent' && text.includes('\n▸ ')) {
    const lines = text.split('\n');
    const options = lines
      .filter((l) => l.trimStart().startsWith('▸'))
      .map((l) => l.replace(/^\s*▸\s*/, '').trim())
      .filter(Boolean);
    const body = lines.filter((l) => !l.trimStart().startsWith('▸')).join(' ').trim();
    if (options.length > 0 && body) {
      return `[you sent tappable options via reply_with_choices] ${body} [options: ${options.join(' | ')}]`;
    }
  }
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

/**
 * Record a run that produced no model reply, so the canned holding
 * lines stop being invisible. Before this, ~9% of production replies
 * were holding lines with nothing anywhere explaining why.
 *
 * Fail-soft by design: this is observability, never a reason to break
 * a customer reply. Tolerates the table not existing yet (the insert
 * just errors and we log it), so it is safe to deploy before the
 * migration is applied.
 */
async function logAgentFailure(
  sb: SupabaseClient,
  conv: { id: string; user_id: string },
  stage: Stage,
  intent: Intent,
  reason: string,
): Promise<void> {
  try {
    const { error } = await sb.from('ai_agent_failures').insert({
      user_id: conv.user_id,
      conversation_id: conv.id,
      stage,
      intent,
      reason,
    });
    if (error) console.warn('[ai-agent] failure log insert failed:', error.message);
  } catch (e) {
    console.warn('[ai-agent] failure log threw:', e instanceof Error ? e.message : e);
  }
}

function filterTools(all: ToolHandler[], allowList: string[] | null): ToolHandler[] {
  if (!allowList || allowList.length === 0) return all;
  return all.filter((t) => allowList.includes(t.name));
}

/**
 * Send via Meta + persist to DB with agent_kind='ai'. Service-role insert
 * (RLS already permits service role on messages — used by the webhook).
 */
async function postAndPersist(
  sb: SupabaseClient,
  waCfg: { phone_number_id: string; access_token: string },
  accessToken: string,
  contact: { id: string; phone: string },
  conversationId: string,
  text: string,
  channel: Channel = 'whatsapp',
  destination: string = contact.phone,
): Promise<void> {
  let waMessageId = '';
  try {
    const r = await sendChannelText({
      channel,
      to: destination,
      text,
      whatsapp: channel === 'whatsapp' ? { phoneNumberId: waCfg.phone_number_id, accessToken } : null,
      email: channel === 'email' ? { conversationId } : null,
    });
    waMessageId = r.messageId;
  } catch (e) {
    console.error('[ai-agent] channel send failed:', channel, e instanceof Error ? e.message : e);
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
