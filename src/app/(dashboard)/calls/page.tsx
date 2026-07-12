'use client';

import { useEffect, useState } from 'react';
import { PhoneIncoming } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WebCallWidget } from '@/components/calls/web-call-widget';

interface VoiceCallRow {
  id: string;
  vapi_call_id: string;
  caller_phone: string | null;
  duration_seconds: number | null;
  ended_reason: string | null;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  created_at: string;
}

const CS_NUMBER = '+1 (689) 345-9115';

function fmtDuration(s: number | null): string {
  if (s === null) return '—';
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function CallsPage() {
  const [calls, setCalls] = useState<VoiceCallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from('voice_calls')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        setCalls((data as VoiceCallRow[]) ?? []);
        setLoading(false);
      });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Calls</h1>
        <p className="mt-1 text-sm text-slate-400">
          Customer service line: <span className="font-medium text-white">{CS_NUMBER}</span> — answered
          by Lucy (AI) around the clock. Every finished call appears below with its summary,
          recording, and transcript.
        </p>
      </div>

      <WebCallWidget />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PhoneIncoming className="h-5 w-5" /> Call history
          </CardTitle>
          <CardDescription>Most recent 100 calls.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : calls.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No calls yet. Dial {CS_NUMBER} (or use “Talk to Lucy” above) — the call will appear
              here within seconds of hanging up.
            </p>
          ) : (
            <div className="space-y-3">
              {calls.map((c) => (
                <div key={c.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {c.caller_phone ?? 'Web call'}{' '}
                        <span className="text-xs font-normal text-muted-foreground">
                          · {fmtDuration(c.duration_seconds)}
                          {c.ended_reason ? ` · ${c.ended_reason}` : ''}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(c.created_at).toLocaleString()}
                      </p>
                    </div>
                    {c.recording_url && (
                      <audio controls preload="none" src={c.recording_url} className="h-9 max-w-60" />
                    )}
                  </div>
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
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
