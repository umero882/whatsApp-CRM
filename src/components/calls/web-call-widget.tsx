'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Phone, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type CallState = 'idle' | 'connecting' | 'live' | 'ending';

/**
 * Browser voice call to Lucy (Vapi Web SDK over WebRTC) — the same
 * assistant that answers the CS phone line. Successor to the old
 * lucy-relay / PersonaPlex web-call bridge, minus the GPU server.
 *
 * Requires NEXT_PUBLIC_VAPI_PUBLIC_KEY and NEXT_PUBLIC_VAPI_ASSISTANT_ID.
 */
export function WebCallWidget() {
  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vapiRef = useRef<any>(null);

  const publicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
  const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
  const configured = Boolean(publicKey && assistantId);

  useEffect(() => {
    return () => {
      vapiRef.current?.stop?.();
    };
  }, []);

  async function startCall() {
    if (!configured) return;
    setError(null);
    setState('connecting');
    try {
      const { default: Vapi } = await import('@vapi-ai/web');
      const vapi = new Vapi(publicKey as string);
      vapiRef.current = vapi;
      vapi.on('call-start', () => setState('live'));
      vapi.on('call-end', () => {
        setState('idle');
        setAssistantSpeaking(false);
      });
      vapi.on('speech-start', () => setAssistantSpeaking(true));
      vapi.on('speech-end', () => setAssistantSpeaking(false));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vapi.on('error', (e: any) => {
        setError(e?.errorMsg || e?.message || 'Call failed');
        setState('idle');
      });
      await vapi.start(assistantId as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the call');
      setState('idle');
    }
  }

  function endCall() {
    setState('ending');
    vapiRef.current?.stop?.();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Phone className="h-5 w-5" /> Talk to Lucy
        </CardTitle>
        <CardDescription>
          Browser voice call to the same AI agent that answers the CS line — use it to test
          what customers hear. Microphone permission required.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        {!configured ? (
          <p className="text-sm text-amber-500">
            Set NEXT_PUBLIC_VAPI_PUBLIC_KEY and NEXT_PUBLIC_VAPI_ASSISTANT_ID to enable web calls.
          </p>
        ) : state === 'idle' ? (
          <Button onClick={startCall}>
            <Phone className="mr-2 h-4 w-4" /> Start call
          </Button>
        ) : state === 'connecting' ? (
          <Button disabled>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Connecting…
          </Button>
        ) : (
          <>
            <Button variant="destructive" onClick={endCall} disabled={state === 'ending'}>
              <PhoneOff className="mr-2 h-4 w-4" /> End call
            </Button>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Mic className={assistantSpeaking ? 'h-4 w-4 text-emerald-500' : 'h-4 w-4 text-primary animate-pulse'} />
              {assistantSpeaking ? 'Lucy is speaking…' : 'Live — Lucy is listening'}
            </span>
          </>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </CardContent>
    </Card>
  );
}
