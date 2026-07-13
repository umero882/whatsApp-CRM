'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Globe,
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WebCallWidget } from '@/components/calls/web-call-widget';
import { OutboundCallDialog, type CallTarget } from '@/components/calls/outbound-call-dialog';

interface VoiceCallRow {
  id: string;
  vapi_call_id: string;
  caller_phone: string | null;
  duration_seconds: number | null;
  ended_reason: string | null;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  direction: 'inbound' | 'outbound' | 'web' | null;
  status: string | null;
  objective: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  created_at: string;
  contacts: { name: string | null } | null;
}

const CS_NUMBER = '+1 (689) 345-9115';
const REFRESH_MS = 15_000;

function fmtDuration(s: number | null): string {
  if (s === null) return '—';
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const DIRECTION_META = {
  inbound: { icon: PhoneIncoming, label: 'Incoming', className: 'text-emerald-400 border-emerald-400/40' },
  outbound: { icon: PhoneOutgoing, label: 'Outbound (Lucy)', className: 'text-sky-400 border-sky-400/40' },
  web: { icon: Globe, label: 'Web test', className: 'text-slate-400 border-slate-600' },
} as const;

export default function CallsPage() {
  const [calls, setCalls] = useState<VoiceCallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialerOpen, setDialerOpen] = useState(false);
  // "Call back" from a history row — pre-fills the dialer with that caller.
  const [callback, setCallback] = useState<CallTarget | null>(null);

  const fetchCalls = useCallback(async () => {
    const { data } = await createClient()
      .from('voice_calls')
      .select('*, contacts(name)')
      .order('created_at', { ascending: false })
      .limit(100);
    setCalls((data as unknown as VoiceCallRow[]) ?? []);
    setLoading(false);
  }, []);

  // Poll — end-of-call reports land server-side, so the page refreshes
  // itself instead of waiting for a manual reload.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCalls();
    const t = setInterval(fetchCalls, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchCalls]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Calls</h1>
          <p className="mt-1 text-sm text-slate-400">
            Customer service line: <span className="font-medium text-white">{CS_NUMBER}</span> —
            answered by Lucy (AI) around the clock. Lucy can also call customers for you.
          </p>
        </div>
        <Button onClick={() => setDialerOpen(true)}>
          <PhoneOutgoing className="size-4" /> Call a customer
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PhoneOutgoing className="h-5 w-5" /> Call a customer
            </CardTitle>
            <CardDescription>
              Pick any contact — or dial a number — and Lucy places the call from the CS line.
              Tell her what the call is about (follow-up, dispute, interview reminder, …) and the
              result lands below and in the customer&apos;s chat timeline.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setDialerOpen(true)}>
              <Phone className="size-4" /> New call
            </Button>
          </CardContent>
        </Card>

        <WebCallWidget />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PhoneIncoming className="h-5 w-5" /> Call history
          </CardTitle>
          <CardDescription>
            Most recent 100 calls — incoming, outbound, and browser tests. Auto-refreshes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : calls.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No calls yet. Dial {CS_NUMBER}, use “Talk to Lucy”, or place an outbound call — it
              will appear here within seconds of hanging up.
            </p>
          ) : (
            <div className="space-y-3">
              {calls.map((c) => {
                const meta = DIRECTION_META[c.direction ?? 'inbound'] ?? DIRECTION_META.inbound;
                const Icon = meta.icon;
                const pending = c.status && c.status !== 'completed' && c.status !== 'failed';
                return (
                  <div key={c.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          <Badge variant="outline" className={`gap-1 text-[10px] ${meta.className}`}>
                            <Icon className="h-3 w-3" /> {meta.label}
                          </Badge>
                          {c.contacts?.name || c.caller_phone || 'Web call'}
                          <span className="text-xs font-normal text-muted-foreground">
                            {pending
                              ? `· ${c.status}…`
                              : c.status === 'failed'
                                ? '· failed'
                                : `· ${fmtDuration(c.duration_seconds)}`}
                            {c.ended_reason ? ` · ${c.ended_reason}` : ''}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {c.contacts?.name && c.caller_phone ? `${c.caller_phone} · ` : ''}
                          {new Date(c.created_at).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {c.caller_phone && (
                          <button
                            type="button"
                            onClick={() =>
                              setCallback({
                                contactId: c.contact_id ?? undefined,
                                name: c.contacts?.name ?? null,
                                phone: c.caller_phone as string,
                              })
                            }
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <PhoneOutgoing className="h-3.5 w-3.5" /> Call back
                          </button>
                        )}
                        {c.conversation_id && (
                          <Link
                            href={`/inbox?c=${c.conversation_id}`}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <MessageSquare className="h-3.5 w-3.5" /> Open chat
                          </Link>
                        )}
                        {c.recording_url && (
                          <audio controls preload="none" src={c.recording_url} className="h-9 max-w-60" />
                        )}
                      </div>
                    </div>
                    {c.objective && (
                      <p className="mt-2 text-xs text-slate-400">
                        <span className="font-medium text-slate-300">Objective:</span> {c.objective}
                      </p>
                    )}
                    {c.summary && <p className="mt-2 text-sm">{c.summary}</p>}
                    {c.transcript && (
                      <button
                        type="button"
                        className="mt-2 text-xs text-primary hover:underline"
                        onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                      >
                        {expanded === c.id ? 'Hide transcript' : 'Show transcript'}
                      </button>
                    )}
                    {expanded === c.id && c.transcript && (
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-3 text-xs text-slate-300">
                        {c.transcript}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <OutboundCallDialog
        open={dialerOpen || callback !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialerOpen(false);
            setCallback(null);
          }
        }}
        target={callback}
        onPlaced={fetchCalls}
      />
    </div>
  );
}
