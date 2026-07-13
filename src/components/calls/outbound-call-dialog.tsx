'use client';

import { useCallback, useRef, useState } from 'react';
import { Loader2, Phone, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface CallTarget {
  contactId?: string;
  name?: string | null;
  phone: string;
}

interface ContactHit {
  id: string;
  name: string | null;
  phone: string;
}

interface OutboundCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected contact (from Contacts / Inbox). Omit for free dialing. */
  target?: CallTarget | null;
  /** Called after Vapi accepts the call — refresh call history etc. */
  onPlaced?: () => void;
}

/**
 * "Lucy, call this customer" — shared dialog behind every call button
 * in the CRM (Calls page dialer, Contacts rows, Inbox header). Without
 * a preset target it offers contact search + manual number entry.
 */
export function OutboundCallDialog({ open, onOpenChange, target, onPlaced }: OutboundCallDialogProps) {
  const [selected, setSelected] = useState<CallTarget | null>(null);
  const [phone, setPhone] = useState('');
  const [objective, setObjective] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset per open (adjust-state-during-render, not an effect) so a
  // stale form never dials the wrong person.
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSelected(target ?? null);
      setPhone('');
      setObjective('');
      setQuery('');
      setHits([]);
      setPlacing(false);
    }
  }

  const runSearch = useCallback((term: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!term.trim()) {
      setHits([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const like = `%${term.trim()}%`;
      const { data } = await createClient()
        .from('contacts')
        .select('id, name, phone')
        .or(`name.ilike.${like},phone.ilike.${like}`)
        .order('updated_at', { ascending: false })
        .limit(8);
      setHits((data as ContactHit[]) ?? []);
      setSearching(false);
    }, 250);
  }, []);

  const dialTo = selected?.phone ?? phone;
  const canPlace = Boolean(dialTo.replace(/\D/g, '').length >= 7) && !placing;

  async function placeCall() {
    setPlacing(true);
    try {
      const res = await fetch('/api/calls/outbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: selected?.contactId,
          phone: selected ? undefined : phone,
          objective: objective.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; number?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Could not place the call');
        setPlacing(false);
        return;
      }
      toast.success(
        `Lucy is calling ${selected?.name || data.number || dialTo} — the call will appear in history once it ends.`,
      );
      onOpenChange(false);
      onPlaced?.();
    } catch {
      toast.error('Could not place the call');
      setPlacing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Phone className="size-4" /> Call a customer
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Lucy (AI) dials from the CS line {'+1 (689) 345-9115'}, speaks with the customer, and
            the summary, recording, and transcript land in Calls and the chat timeline.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {selected ? (
            <div className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">
                  {selected.name || 'Unnamed contact'}
                </p>
                <p className="font-mono text-xs text-slate-400">{selected.phone}</p>
              </div>
              {!target && (
                <button
                  type="button"
                  aria-label="Clear selected contact"
                  onClick={() => setSelected(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label className="text-slate-300">Find a contact</Label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
                  <Input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      runSearch(e.target.value);
                    }}
                    placeholder="Search by name or phone…"
                    className="pl-8 bg-slate-950 border-slate-700 text-white placeholder:text-slate-500"
                  />
                </div>
                {searching && <p className="text-xs text-slate-500">Searching…</p>}
                {hits.length > 0 && (
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-700 divide-y divide-slate-800">
                    {hits.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() =>
                          setSelected({ contactId: h.id, name: h.name, phone: h.phone })
                        }
                        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-800"
                      >
                        <span className="truncate text-sm text-white">
                          {h.name || 'Unnamed'}
                        </span>
                        <span className="ml-2 shrink-0 font-mono text-xs text-slate-400">
                          {h.phone}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-300">…or dial a number</Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+971 58 123 4567"
                  className="bg-slate-950 border-slate-700 font-mono text-white placeholder:text-slate-500"
                />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label className="text-slate-300">What is the call about? (optional)</Label>
            <Textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="e.g. follow up on their maid request, resolve the payment dispute, confirm tomorrow's interview…"
              className="bg-slate-950 border-slate-700 text-white placeholder:text-slate-500"
            />
            <p className="text-xs text-slate-500">
              Lucy opens the call with this, so be specific.
            </p>
          </div>
        </div>

        <DialogFooter className="bg-slate-900 border-slate-700">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </Button>
          <Button onClick={placeCall} disabled={!canPlace}>
            {placing ? <Loader2 className="size-4 animate-spin" /> : <Phone className="size-4" />}
            Place call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
