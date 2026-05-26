'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, RefreshCw, Loader2, X, Settings as SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import type { Message } from '@/types';
import { cn } from '@/lib/utils';

interface AICopilotPanelProps {
  conversationId: string | null;
  latestMessage: Message | null;
  /** Receives the chosen suggestion text. Caller decides send vs. compose-insert. */
  onSelect: (text: string) => void;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; suggestions: string[]; provider: string; model: string }
  | { kind: 'no-provider' }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | { kind: 'hidden' };

/**
 * Sits between the message scroll area and the composer. When the
 * latest message is from the customer and we haven't already drafted
 * for that turn, fetches three suggested replies. The agent clicks
 * one (or refreshes / dismisses).
 *
 * Auto-fetch is keyed off the message id, so it fires exactly once
 * per customer turn — switching conversations or arrival of a NEW
 * inbound message both retrigger.
 */
export function AICopilotPanel({
  conversationId,
  latestMessage,
  onSelect,
}: AICopilotPanelProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const lastTriggerKey = useRef<string | null>(null);

  const triggerKey =
    latestMessage && latestMessage.sender_type === 'customer'
      ? `${conversationId ?? 'none'}::${latestMessage.id}`
      : null;

  const fetchSuggestions = useCallback(async () => {
    if (!conversationId) return;
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/ai/draft-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 412 && data?.code === 'no_provider') {
        setState({ kind: 'no-provider' });
        return;
      }
      if (res.status === 412 && data?.code === 'provider_disabled') {
        setState({ kind: 'disabled' });
        return;
      }
      if (!res.ok) {
        setState({ kind: 'error', message: data?.error || `HTTP ${res.status}` });
        return;
      }
      const suggestions: string[] = Array.isArray(data?.suggestions) ? data.suggestions : [];
      if (!suggestions.length) {
        setState({ kind: 'error', message: 'Empty response' });
        return;
      }
      setState({
        kind: 'ready',
        suggestions,
        provider: data.provider,
        model: data.model,
      });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'network error',
      });
    }
  }, [conversationId]);

  // Auto-fetch on new customer turn. Dismiss flips state to hidden;
  // we re-arm only when a NEW customer message arrives.
  useEffect(() => {
    if (!triggerKey) {
      setState({ kind: 'idle' });
      lastTriggerKey.current = null;
      return;
    }
    if (state.kind === 'hidden' && lastTriggerKey.current === triggerKey) return;
    if (lastTriggerKey.current === triggerKey && state.kind !== 'idle') return;
    lastTriggerKey.current = triggerKey;
    void fetchSuggestions();
  }, [triggerKey, fetchSuggestions, state.kind]);

  if (state.kind === 'idle' || state.kind === 'hidden') return null;

  const wrapper = (children: React.ReactNode) => (
    <div className="border-t border-slate-800 bg-slate-900/95 backdrop-blur px-3 py-2 sm:px-4">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" />
          <span className="font-medium text-slate-300">AI suggestions</span>
          {state.kind === 'ready' && (
            <span className="text-slate-600">· {state.provider}/{state.model}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={fetchSuggestions}
            disabled={state.kind === 'loading'}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-50"
            aria-label="Refresh suggestions"
          >
            <RefreshCw className={cn('size-3.5', state.kind === 'loading' && 'animate-spin')} />
          </button>
          <button
            type="button"
            onClick={() => setState({ kind: 'hidden' })}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            aria-label="Hide suggestions"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );

  if (state.kind === 'loading') {
    return wrapper(
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="size-3.5 animate-spin" />
        Drafting suggestions…
      </div>,
    );
  }

  if (state.kind === 'no-provider') {
    return wrapper(
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span>Configure an AI provider to enable reply suggestions.</span>
        <Link
          href="/settings?tab=ai"
          className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-primary hover:bg-primary/20"
        >
          <SettingsIcon className="size-3" />
          Set up
        </Link>
      </div>,
    );
  }

  if (state.kind === 'disabled') {
    return wrapper(
      <div className="text-xs text-slate-500">
        AI suggestions are turned off in <Link href="/settings?tab=ai" className="text-primary hover:underline">Settings → AI Provider</Link>.
      </div>,
    );
  }

  if (state.kind === 'error') {
    return wrapper(
      <div className="flex items-center justify-between gap-2 text-xs text-red-400">
        <span className="truncate">Couldn&apos;t draft: {state.message}</span>
        <button
          type="button"
          onClick={fetchSuggestions}
          className="rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700"
        >
          Try again
        </button>
      </div>,
    );
  }

  return wrapper(
    <div className="flex flex-wrap gap-2">
      {state.suggestions.map((s, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onSelect(s)}
          className="max-w-full whitespace-normal rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-left text-xs text-slate-200 hover:border-primary hover:bg-slate-700 hover:text-white"
        >
          {s}
        </button>
      ))}
    </div>,
  );
}
