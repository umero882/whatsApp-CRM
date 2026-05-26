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

/** 24h gap = treat as a fresh conversation. */
const RETURN_GAP_MS = 24 * 60 * 60 * 1000;

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
  contact:
    | { id: string; name: string | null; phone: string }[]
    | { id: string; name: string | null; phone: string }
    | null;
}

interface HistoryRow {
  sender_type: 'customer' | 'agent';
  content_type: string;
  content_text: string | null;
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
    .select('id, user_id, ai_paused_until, contact:contacts(id, name, phone)')
    .eq('id', conversationId)
    .maybeSingle();
  if (convErr) throw new Error(`load conversation: ${convErr.message}`);
  if (!convRaw) return { kind: 'skipped', reason: 'conversation_not_found' };
  const conv = convRaw as ConversationRow;
  const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;
  if (!contact?.phone) return { kind: 'skipped', reason: 'no_contact_phone' };

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
    .select('sender_type, content_type, content_text, agent_kind, created_at')
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
    whatsapp: {
      phoneNumberId: waCfg.phone_number_id,
      accessToken,
    },
  };

  const allowedTools = filterTools(ETHIOPIAN_MAIDS_TOOLS, agent.enabled_tools);
  // STRONG GATE: when stage forbids tools, the model literally can't
  // call them. Stronger than relying on the prompt to say "don't".
  const stageTools: ToolHandler[] = allowTools ? allowedTools : [];
  const toolSpecs = toolsToSpecs(stageTools);

  // ─── Compose system prompt ──────────────────────────────────────────
  const persona = (agent.system_prompt ?? '').trim() || defaultPersona(agent.business_name);
  const runtimeBlock = buildRuntimeBlock(stage, intent, language, customerContext, allowedTools, allowTools);
  const directive = OPERATING_DIRECTIVE;
  const systemPrompt = [persona, runtimeBlock, directive].join('\n\n');

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

  // ─── Loop ───────────────────────────────────────────────────────────
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
        await postAndPersist(sb, waCfg, accessToken, contact, conv.id,
          stageHoldingReply(stage, language));
        return { kind: 'failed', reason: `provider: ${e.message}` };
      }
      throw e;
    }

    if (result.kind === 'text') {
      const text = result.text.trim();
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
      console.log('[ai-agent] turn', turn + 1, 'reply:', text.slice(0, 120));
      await postAndPersist(sb, waCfg, accessToken, contact, conv.id, text);
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
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: safeJsonString(resultJson),
      });
    }
  }

  // Loop exhausted — stage-aware holding reply
  console.warn('[ai-agent] max_turns reached without final reply');
  await postAndPersist(sb, waCfg, accessToken, contact, conv.id,
    stageHoldingReply(stage, language));
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
type Intent = 'sponsor' | 'job_seeker' | 'unknown';

const SPONSOR_PATTERNS = [
  /\b(i\s*(need|want|am\s*looking\s*for|require)\s*(a\s*)?(maid|nanny|housekeeper|domestic|helper|cook|elderly\s*care|cleaner|sirvienta|sirvient|خادم|مربية))\b/i,
  /\b(hire|hiring|to\s*hire|want\s*to\s*hire|looking\s*to\s*hire)\b/i,
  /\b(for\s*my\s*(kids|children|baby|family|parents|home|house))\b/i,
  /\b(احتاج|ابغى|اريد|اطلب|ابحث\s*عن).*(خادم|مربية|عاملة)/i,
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
  const hasSponsorCriteria = /\b(dubai|abu\s*dhabi|sharjah|ajman|fujairah|ras\s*al\s*khaimah|umm\s*al\s*quwain|live[\s-]*in|live[\s-]*out|cook|cleaning|childcare|elderly|nanny|babys|housekeep|housekeeper)\b/i.test(
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

type Lang = 'English' | 'Arabic' | 'Amharic' | 'Urdu' | 'Hindi';

function detectLanguage(text: string): Lang {
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
  allTools: ToolHandler[],
  toolsAllowedThisTurn: boolean,
): string {
  const toolList = allTools.map((t) => `${t.name} — ${t.description.split('.')[0]}.`).join('\n  • ');
  const stageGuide = STAGE_GUIDANCE[stage];
  const intentGuide = INTENT_GUIDANCE[intent];
  const customerLine = ctx.name
    ? `Customer name: ${ctx.name}${ctx.isReturning ? ' (returning customer — DO NOT re-greet, continue naturally)' : ''}`
    : (ctx.isReturning ? 'Returning customer (DO NOT re-greet, continue from previous context).' : 'New customer — first contact.');
  const toolsLine = toolsAllowedThisTurn
    ? `Tools available NOW (${allTools.length}):\n  • ${toolList}`
    : `Tools are DISABLED for this turn (stage ${stage}). Reply in plain text only — do not attempt to call tools.`;
  return `═══ RUNTIME CONTEXT ═══
STAGE: ${stage}
INTENT: ${intent}
LANGUAGE: ${language} (reply in this language)
${customerLine}
Customer turns so far in this conversation: ${ctx.customerTurns}

INTENT GUIDANCE (critical — read first):
${intentGuide}

STAGE GUIDANCE:
${stageGuide}

${toolsLine}
═══════════════════════`;
}

const STAGE_GUIDANCE: Record<Stage, string> = {
  GREETING:
    'This is a fresh conversation. Send a warm welcome that names the business. Do NOT assume the customer wants to hire OR is looking for work — you do not know yet. Do NOT ask questions yet, do NOT call tools. One friendly sentence is plenty.',
  DISCOVERY:
    'You have greeted the customer. Now figure out WHAT they want. Read the INTENT GUIDANCE above and ACT ON IT — if intent=sponsor, ask sponsor questions. If intent=job_seeker, ask THEM about their experience and where they want to work. If intent=unknown, ask ONE clarifying question: "Are you looking to hire a maid, or are you looking for work yourself?" Do NOT call tools.',
  QUALIFICATION:
    'You know the customer intent (see INTENT GUIDANCE above). Gather the relevant basics with ONE question per turn, skipping what you already know from history. Do NOT call tools until you have enough info per the intent guidance.',
  RECOMMENDATION:
    'You have enough info to make a recommendation. Use the right tool for the intent (search_maids for sponsors, list_jobs for job seekers). Present 2-3 results max. Offer the next step.',
  BOOKING:
    'Customer is engaging — interested in a candidate, asking pricing, or ready to apply. Use get_maid_profile / get_pricing for sponsors; for job seekers, take down their details and confirm next steps. Be specific and concrete.',
  CLOSE:
    'Customer is wrapping up. Acknowledge briefly and warmly. Leave the door open for future contact. Do NOT call tools.',
};

const INTENT_GUIDANCE: Record<Intent, string> = {
  sponsor: `Customer is a SPONSOR seeking to HIRE a maid (family, employer, or representative).
Qualification questions to gather (one per turn, skip if already answered):
  1. Which emirate are you in?
  2. Live-in or live-out?
  3. Main duties (childcare / cooking / elderly care / general)?
  4. When do you need her to start?
  5. Any language or experience preference?

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

For pricing: call get_pricing(country: "UAE").`,

  job_seeker: `Customer IS a MAID looking for WORK (or someone applying on her behalf).
Do NOT ask her to hire anyone. Do NOT ask which emirate she wants TO HIRE FROM.
Qualification questions to gather (one per turn, skip if already answered):
  1. Where are you currently located (country)?
  2. How many years of experience as a domestic worker?
  3. What skills — childcare, cooking, elderly care, cleaning?
  4. Which destination country / emirate do you want to work in?
  5. When are you available to start?
  6. What languages do you speak?
Recommendation: when you have country + experience + destination, call list_jobs
with location (the destination) to surface matching openings. Present 1-3 open
roles with title, location, salary range.
For application: do NOT promise placement. Take down their details and tell them
our recruitment team will reach out. Use escalate_to_human(reason: "job application")
to flag for human follow-up.`,

  unknown: `You do NOT yet know if this customer wants to hire a maid (sponsor) or
is looking for work themselves (job seeker). Your job in DISCOVERY is to find out
with ONE clarifying question. Suggested phrasing:
  English: "Are you looking to hire a maid, or are you looking for work yourself?"
  Arabic:  "هل تبحث عن خادمة للتوظيف، أم تبحث عن عمل لنفسك؟"
Do NOT assume one side. Do NOT ask emirate/duties yet — that only makes sense
once we know they're a sponsor.`,
};

const OPERATING_DIRECTIVE = `═══ OPERATING RULES ═══
• You are speaking DIRECTLY to the customer on WhatsApp. Your output IS the message they receive — no preamble like "Sure, I can help".
• Reply length: 1–3 short sentences. Plain text only — WhatsApp does not render markdown.
• ONE WhatsApp message per turn. No multi-part bursts.
• Use the customer's name once you know it. Never "Dear Sir/Madam".
• ONE question per turn at most. Don't interrogate.
• NEVER invent candidates, prices, availability, or policies. Use the tools when they're enabled.
• NEVER share a maid's full name, passport number, exact location, or phone before a confirmed booking.
• We place Ethiopian domestic workers in the GCC only. Politely decline anything else.

ESCALATE (call escalate_to_human) ONLY for: complaints, refunds, contracts, visa/legal specifics, safety concerns, customer is angry, or off-topic after one polite decline. NEVER escalate because a tool errored or because a question is vague — ask back instead.

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

function stringifyHistoryMessage(m: HistoryRow): string {
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
