'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Bot,
  Eye,
  EyeOff,
  Loader2,
  Power,
  PowerOff,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const MASKED = '••••••••••••••••';

// The polished playbook prompt. The server (src/lib/ai/agent.ts)
// adds a RUNTIME CONTEXT block (stage, language, customer name,
// available tools) and an OPERATING DIRECTIVE block before each call,
// so this prompt focuses purely on persona + the business playbook.
// Tool gating, language detection, and stage tracking are server-side.
const DEFAULT_SYSTEM_PROMPT = `You are Habiba — the WhatsApp customer-service agent for Ethiopian Maids,
a licensed UAE recruitment agency placing Ethiopian domestic workers
(maids, nannies, cooks, elder-care helpers) with sponsor families in the
GCC. On WhatsApp you talk to TWO kinds of customers:
  • SPONSORS — families/employers looking to HIRE a maid
  • JOB SEEKERS — maids (or recruiters on their behalf) looking for WORK
Never assume which side you're on until you've identified the intent.
The server tells you the current INTENT before each reply — honor it.

═══════════════════════════════════════════════════════════
CONVERSATION PLAYBOOK — KNOW WHERE YOU ARE
═══════════════════════════════════════════════════════════
The server tells you the current STAGE before each reply. Behave
accordingly:

【GREETING】 — first contact (or 24h+ since last reply)
  • Warm welcome that names the business.
  • Match the customer's language.
  • ONE friendly opener. NO questions yet. NO tools.
  Example: "Welcome to Ethiopian Maids 🌸 How can I help you today?"

【DISCOVERY】 — greeted, intent still unclear
  • If the customer's first message gives away the intent ("I need a
    maid" → sponsor; "I need a job" / "looking for work" → job seeker),
    move straight into QUALIFICATION for that side.
  • If genuinely ambiguous, ask ONE clarifying question:
      EN: "Are you looking to hire a maid, or looking for work yourself?"
      AR: "هل تبحث عن خادمة للتوظيف، أم تبحث عن عمل لنفسك؟"
  • Do NOT call tools.

【QUALIFICATION】 — gather requirements (different per intent)

  IF INTENT = SPONSOR (wants to hire):
    Ask ONE question per turn, in this order, skipping what you know:
      1. Which emirate are you in?
      2. Live-in or live-out?
      3. Main duties (childcare / cooking / elderly care / general)?
      4. When do you need her to start?
      5. Any languages or experience preference?
    Do NOT ask about budget unless the customer brings it up.
    Move to RECOMMENDATION when you have emirate AND one of
    {duties, live-in/out}.

  IF INTENT = JOB_SEEKER (the maid wants work):
    Ask ONE question per turn, in this order, skipping what you know:
      1. Where are you currently located (country)?
      2. How many years of experience as a domestic worker?
      3. What skills — childcare / cooking / elderly / cleaning?
      4. Which destination country / emirate do you want to work in?
      5. When can you be available to start?
      6. What languages do you speak?
    Do NOT promise placement. Do NOT ask her to hire anyone.

【RECOMMENDATION】 — enough info to recommend

  SPONSOR: TWO-step card flow, never plain-text listing:
    (1) call search_maids with the criteria you have
    (2) pick top 1–3 ids, call send_maid_cards({maid_ids:[...]})
        — this sends each maid as a photo + caption WhatsApp card
    (3) your FINAL text is ONE sentence: "Want details on any of
        them? Reply with the name."
    NEVER list candidate details in text after sending cards. NEVER
    share full names, IDs, exact location, or contact info.

  JOB_SEEKER: call list_jobs(location: destination_country) to surface
  open postings. Present 1–3 by title + location + salary range. If
  none match: "I don't have an open role matching that right now —
  shall I take your details so our team reaches out when one opens?"

【BOOKING】 — customer engaging or asking specifics

  SPONSOR: for details → get_maid_profile. For fees → get_pricing
  with the country. Quote the exact amount, never round or invent.
  Offer to schedule an interview or visit.

  JOB_SEEKER: take down their details (name confirmation, phone,
  passport status, availability date), then call escalate_to_human
  with reason "job application — [country, experience]" so our
  recruitment team can follow up.

【CLOSE】 — customer wrapping up
  • Acknowledge briefly. Leave the door open.
  Example: "Anytime. Reach out whenever you're ready 🌸"

═══════════════════════════════════════════════════════════
HARD RULES (never break these)
═══════════════════════════════════════════════════════════
• NEVER invent candidates, prices, availability, or policies.
• NEVER share a maid's full name, passport, exact location, or phone
  before a confirmed booking deposit.
• NEVER promise specific visa timelines.
• We place ETHIOPIAN domestic workers in the GCC only. Politely
  decline other nationalities or other services (drivers, nurses).
  Offer to take details for the future.
• ONE WhatsApp message per turn. Plain text only. 1–3 short sentences.
• Match the customer's language exactly (English / Arabic / Amharic
  / Urdu / Hindi). Default English if mixed or unclear.
• Use the customer's name once you know it. Never "Dear Sir/Madam".

═══════════════════════════════════════════════════════════
ESCALATE TO HUMAN — only for these real triggers
═══════════════════════════════════════════════════════════
✓ Complaint about service or a maid
✓ Refund / money-back request
✓ Contract signing or legal question
✓ Visa or immigration specifics beyond general info
✓ Safety, abuse, or trafficking concern (urgent=true)
✓ Customer is clearly angry or upset
✓ Off-topic / out of scope after one polite decline

DO NOT escalate because:
✗ A tool returned no results — say so honestly and offer to widen
✗ The customer's question is vague — ask back
✗ You're not sure — ask back

When you escalate: call escalate_to_human(reason, urgent), then send
ONE short reply: "Let me get one of our team on this — they'll reply
shortly." That's all.

═══════════════════════════════════════════════════════════
WHEN UNCERTAIN
═══════════════════════════════════════════════════════════
Always prefer a brief clarifying question over a tool call or guess.
"Just to make sure I find you the right person — which emirate are
you in?" is better than running a wide search.`;

export function AIAgentConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);

  const [isEnabled, setIsEnabled] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [maxTurns, setMaxTurns] = useState(4);
  const [humanPauseMinutes, setHumanPauseMinutes] = useState(60);
  const [hasuraUrl, setHasuraUrl] = useState('');
  const [hasuraSecret, setHasuraSecret] = useState('');
  const [hasuraSecretEdited, setHasuraSecretEdited] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/agent-config');
      const data = await res.json();
      const cfg = data.config;
      if (cfg) {
        setHasExisting(true);
        setIsEnabled(cfg.is_enabled);
        setBusinessName(cfg.business_name || '');
        setSystemPrompt(cfg.system_prompt || '');
        setMaxTurns(cfg.max_turns ?? 4);
        setHumanPauseMinutes(cfg.human_pause_minutes ?? 60);
        setHasuraUrl(cfg.hasura_url || '');
        setHasuraSecret(cfg.hasura_admin_secret || '');
        setHasuraSecretEdited(false);
      } else {
        setHasExisting(false);
      }
    } catch (e) {
      console.error('Load agent config failed:', e);
      toast.error('Failed to load AI agent configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  async function handleSave() {
    try {
      setSaving(true);
      const payload: Record<string, unknown> = {
        is_enabled: isEnabled,
        business_name: businessName.trim() || null,
        system_prompt: systemPrompt.trim() || null,
        max_turns: maxTurns,
        human_pause_minutes: humanPauseMinutes,
        hasura_url: hasuraUrl.trim() || null,
        enabled_tools: [],
      };
      if (hasuraSecretEdited) {
        payload.hasura_admin_secret = hasuraSecret;
      }
      const res = await fetch('/api/ai/agent-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Save failed');
        return;
      }
      toast.success('AI agent settings saved');
      await loadConfig();
    } catch (e) {
      console.error('Save agent config failed:', e);
      toast.error('Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!confirm('Delete the AI agent configuration?')) return;
    try {
      setResetting(true);
      const res = await fetch('/api/ai/agent-config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Reset failed');
        return;
      }
      toast.success('AI agent config cleared');
      setHasExisting(false);
      setIsEnabled(false);
      setBusinessName('');
      setSystemPrompt('');
      setMaxTurns(4);
      setHumanPauseMinutes(60);
      setHasuraUrl('');
      setHasuraSecret('');
      setHasuraSecretEdited(false);
    } catch (e) {
      console.error('Reset agent config failed:', e);
      toast.error('Reset failed');
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px] mt-4">
      <div className="space-y-6">
        <Alert className="bg-slate-900 border-slate-700">
          <div className="flex items-center gap-2">
            {isEnabled ? (
              <Power className="size-4 text-primary" />
            ) : (
              <PowerOff className="size-4 text-slate-500" />
            )}
            <AlertTitle className="text-white mb-0">
              AI Agent is {isEnabled ? 'ACTIVE' : 'OFF'}
            </AlertTitle>
          </div>
          <AlertDescription className="text-slate-400">
            {isEnabled
              ? 'When a customer sends a WhatsApp message, the agent will read it, call tools if needed (search maids, get pricing, escalate to human), and send the reply automatically. A human reply pauses the agent for the configured window.'
              : 'The agent is disabled. Inbound messages will not get auto-replies. Configure provider + Hasura below, then flip the switch.'}
          </AlertDescription>
        </Alert>

        <Card className="bg-slate-900 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Bot className="size-4 text-primary" />
              Agent Persona
            </CardTitle>
            <CardDescription className="text-slate-400">
              The role + voice prompt the agent uses for every reply. Tools and the JSON wire format are added automatically by the server — focus this on personality, business rules, and escalation policy.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => setIsEnabled(e.target.checked)}
                className="size-4 rounded border-slate-700 bg-slate-800 text-primary focus:ring-primary"
              />
              Enable AI Agent on all conversations
            </label>

            <div className="space-y-2">
              <Label className="text-slate-300">Business Name</Label>
              <Input
                placeholder="Ethiopian Maids"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              />
              <p className="text-xs text-slate-500">
                Used in the default persona prompt. Override fully via the system prompt below.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-slate-300">System Prompt</Label>
                <button
                  type="button"
                  onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
                  className="text-xs text-primary hover:underline"
                >
                  Use Habiba (Ethiopian Maids) preset
                </button>
              </div>
              <textarea
                placeholder="Leave blank for a generic default. Paste your own persona for production."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={10}
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-xs text-white placeholder:text-slate-500 focus:border-primary focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Max LLM turns per reply</Label>
                <Input
                  type="number"
                  min={1}
                  max={12}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(Math.min(12, Math.max(1, Number(e.target.value) || 4)))}
                  className="bg-slate-800 border-slate-700 text-white"
                />
                <p className="text-xs text-slate-500">Anti-runaway cap. 4 covers most tool chains.</p>
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Human pause (minutes)</Label>
                <Input
                  type="number"
                  min={0}
                  value={humanPauseMinutes}
                  onChange={(e) => setHumanPauseMinutes(Math.max(0, Number(e.target.value) || 0))}
                  className="bg-slate-800 border-slate-700 text-white"
                />
                <p className="text-xs text-slate-500">After a human reply, agent stays silent this long.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white">Tool Backend — Hasura</CardTitle>
            <CardDescription className="text-slate-400">
              The agent calls your Hasura GraphQL endpoint for live maid availability and pricing. Admin secret stored AES-256-GCM encrypted with the same scheme as the WhatsApp token.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-slate-300">Hasura GraphQL URL</Label>
              <Input
                placeholder="https://hasura.ethiopianmaids.net/v1/graphql"
                value={hasuraUrl}
                onChange={(e) => setHasuraUrl(e.target.value)}
                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-slate-300">Hasura Admin Secret</Label>
              <div className="relative">
                <Input
                  type={showSecret ? 'text' : 'password'}
                  placeholder="x-hasura-admin-secret value"
                  value={hasuraSecret}
                  onChange={(e) => {
                    setHasuraSecret(e.target.value);
                    setHasuraSecretEdited(true);
                  }}
                  onFocus={() => {
                    if (hasuraSecret === MASKED) {
                      setHasuraSecret('');
                      setHasuraSecretEdited(true);
                    }
                  }}
                  className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 pr-10 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {hasExisting && !hasuraSecretEdited && hasuraSecret && (
                <p className="text-xs text-slate-500">
                  Secret hidden. Leave masked to keep current value; type to replace.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Agent Settings'
            )}
          </Button>
          {hasExisting && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Resetting...
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  Reset
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      <div>
        <Card className="bg-slate-900 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-base">How the agent works</CardTitle>
            <CardDescription className="text-slate-400">
              From inbound WhatsApp to outbound reply.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-400">
            <p>
              <strong className="text-slate-200">1. Inbound</strong> — a customer sends a WhatsApp message. The webhook persists it.
            </p>
            <p>
              <strong className="text-slate-200">2. Agent run</strong> — if enabled and not paused, the LLM reads the last 20 messages plus your persona prompt. It may call tools (search maids, get pricing) before forming a reply.
            </p>
            <p>
              <strong className="text-slate-200">3. Outbound</strong> — the LLM&apos;s final reply is sent via Meta. The message bubble in the inbox is marked with a robot icon.
            </p>
            <p>
              <strong className="text-slate-200">4. Human takeover</strong> — any human reply pauses the agent for the configured window. After that, the agent re-engages on the next customer message if still enabled.
            </p>
            <p>
              <strong className="text-slate-200">5. Escalation</strong> — the agent can call <code className="text-primary">escalate_to_human</code> to pause itself for 24h and tag the conversation for human pickup.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
