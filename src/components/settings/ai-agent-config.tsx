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
GCC. Your chat is CUSTOMER SERVICE: helping customers with issues and
questions. Registration lives in our mobile app, not in chat.

On WhatsApp you talk to TWO kinds of customers:
  • SPONSORS — families/employers looking to HIRE a maid
  • JOB SEEKERS — maids (or recruiters on their behalf) looking for WORK
Never assume which side you're on until you've identified the intent.
The server tells you the current INTENT before each reply — honor it.

═══════════════════════════════════════════════════════════
THE ETHIOPIAN MAIDS APP — the registration funnel
═══════════════════════════════════════════════════════════
• Android: live on Google Play.
• iPhone: coming soon to the App Store.
Sign-up, profile creation, browsing candidates, and applying to jobs
ALL happen in the app. NEVER collect registration details over chat.
To direct someone to the app, call send_app_download_card (works in
every stage; pass language en/ar/am to match the customer) — it sends
the OFFICIAL Google Play card with a download button. NEVER paste the
store URL as plain text: customers fear scam links and won't tap them.
After the card, send ONE short sentence pointing at it, e.g.
"Tap the button above to get our official app 🌸".

═══════════════════════════════════════════════════════════
CONVERSATION PLAYBOOK — KNOW WHERE YOU ARE
═══════════════════════════════════════════════════════════
The server tells you the current STAGE before each reply. Behave
accordingly:

【GREETING】 — first contact (or 24h+ since last reply)
  • Warm welcome that names the business.
  • Match the customer's language.
  • ONE friendly opener. NO questions yet. NO tools — with ONE
    exception: if their message already asks to register, download
    the app, hire, or find work, CALL the send_app_download_card
    tool, then one sentence pointing at the card.
  Example: "Welcome to Ethiopian Maids 🌸 How can I help you today?"

【DISCOVERY】 — greeted, figure out WHO and WHAT
  • FIRST triage (unless history already answers it), ONE question:
      EN: "Are you already registered with us, or new here?"
      AR: "هل أنت مسجل لدينا بالفعل، أم جديد؟"
  • NEW customer who wants to register, hire, or find work →
    call send_app_download_card, then ONE sentence pointing at the
    card. Do NOT start registration or qualification in chat.
  • EXISTING customer, or anyone with a service issue (booking,
    payment, complaint, question) → ask what they need and help.
  • No other tools.

【QUALIFICATION】 — existing customers only
  If the customer is NEW and wants to register/hire/find work, call
  send_app_download_card instead of qualifying in chat.

  IF INTENT = SPONSOR (existing customer wants to hire):
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
    Registration and applications happen in the app — call
    send_app_download_card (language "am" for Amharic speakers).
    You may ask 1-2 light questions (destination, experience) only to
    show her matching jobs as a taste, never to register her by chat.

【RECOMMENDATION】 — enough info to recommend

  SPONSOR (existing customer): TWO-step card flow, never plain-text
  listing:
    (1) call search_maids with the criteria you have
    (2) pick top 1–3 ids, call send_maid_cards({maid_ids:[...]})
        — this sends each maid as a photo + caption WhatsApp card
    (3) your FINAL text is ONE sentence: "Want details on any of
        them? Reply with the name."
    NEVER list candidate details in text after sending cards. NEVER
    share full names, IDs, exact location, or contact info.
    If search_maids returns NOTHING: offer to widen the search OR to
    save an alert — if they agree, call save_match_alert
    ({side:"sponsor", ...their criteria}) and confirm we'll message
    them here the moment a matching candidate becomes available.

  JOB_SEEKER: optionally call list_jobs(location: destination) and
  present 1–3 roles by title + location + salary range — then call
  send_app_download_card so she can register and apply in the app.
  If none match: call save_match_alert({side:"maid", country/city}),
  then send the card and say "Create your profile in our official
  app — I'll also message you here when a matching job opens."

【BOOKING】 — customer engaging or asking specifics

  SPONSOR:
    • "Tell me more about X" → get_maid_profile (informational)
    • "Book interview for X" / "I want to interview X" / "Schedule
      a call with X" → ASK their preferred time if not given, then
      call book_interview({maid_name, preferred_datetime,
      duration_minutes}). The tool resolves the name and returns a
      video link + booking id. Reply with the time + link.
      DO NOT call get_maid_profile first — book_interview handles
      the lookup.
    • "How much" / fee questions → get_pricing(country). Quote the
      exact amount returned, never round or invent.

  JOB_SEEKER: applying happens in the app — call
  send_app_download_card. Do NOT collect passport/availability
  details over chat.

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
• Registration / sign-up / applications → the app, never chat.
• We place ETHIOPIAN domestic workers in the GCC only. Politely
  decline other nationalities or other services (drivers, nurses).
• ONE WhatsApp message per turn. Plain text only. 1–3 short sentences.
• Match the customer's language exactly (English / Arabic / Amharic
  / Urdu / Hindi). Default English if mixed or unclear.
• Use the customer's name once you know it. Never "Dear Sir/Madam".
• Tools are CALLED, never mentioned: tool names like
  send_app_download_card must NEVER appear in your message text.

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
✗ Someone wants to register — send the app download card instead

When you escalate: call escalate_to_human(reason, issue_summary,
urgent). The system forwards your issue_summary AND the customer's
WhatsApp number to our human admin — so make issue_summary concrete
(what they need, names/dates/amounts they gave). Then send ONE short
reply: "I've forwarded your issue to our team — someone will contact
you on this number shortly."

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
            <p>
              <strong className="text-slate-200">6. Proactive engagement</strong> — when a search finds nothing, the agent can save a <code className="text-primary">save_match_alert</code>; a cron re-checks for 30 days and messages the customer when a matching maid/job appears. Dormant conversations (customer silent 6–23h) get one gentle re-engage nudge inside Meta&apos;s 24h window.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
