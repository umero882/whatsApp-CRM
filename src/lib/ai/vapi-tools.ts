/**
 * Voice-agent tool bridge — pure logic for /api/ai/vapi/tools.
 *
 * Vapi hosts the speech loop (ASR ↔ LLM ↔ TTS) for WhatsApp calls and
 * calls back into the CRM whenever voice-Lucy needs live data. This
 * module parses Vapi's tool-call webhook payload and formats results,
 * so voice-Lucy shares the exact same knowledge base and marketplace
 * data as chat-Lucy.
 *
 * Vapi request shape (server tool):
 *   { message: { type: 'tool-calls', toolCallList: [
 *       { id, function: { name, arguments } } ] } }
 * Response shape:
 *   { results: [ { toolCallId, result: string } ] }
 */

export interface VapiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Parse Vapi's webhook body into normalized tool calls. Tolerates both
 * `toolCallList` and `toolCalls` field names and string-or-object
 * arguments. Returns [] for non-tool-call messages. Pure.
 */
export function parseVapiToolCalls(body: unknown): VapiToolCall[] {
  const message = (body as { message?: Record<string, unknown> })?.message;
  if (!message || message.type !== 'tool-calls') return [];
  const rawList = (message.toolCallList ?? message.toolCalls) as unknown;
  if (!Array.isArray(rawList)) return [];
  const calls: VapiToolCall[] = [];
  for (const item of rawList) {
    const fn = (item as { function?: { name?: unknown; arguments?: unknown } }).function;
    const id = (item as { id?: unknown }).id;
    if (!fn?.name || typeof id !== 'string') continue;
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === 'string') {
      try {
        args = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch { /* leave empty */ }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments as Record<string, unknown>;
    }
    calls.push({ id, name: String(fn.name), args });
  }
  return calls;
}

/** Vapi wants each tool result as a plain string. Pure. */
export function vapiResult(toolCallId: string, value: unknown): { toolCallId: string; result: string } {
  return {
    toolCallId,
    result: typeof value === 'string' ? value : JSON.stringify(value),
  };
}

// ────────────────────────────────────────────────────────────────────
// End-of-call reports → inbox call log
// ────────────────────────────────────────────────────────────────────

export interface VapiCallReport {
  callId: string;
  /** Digits-only caller number when extractable (from E.164 or SIP URI). */
  callerDigits: string | null;
  endedReason: string | null;
  durationSeconds: number | null;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
}

/** "sip:971588593894@sip.vapi.ai" | "+971 58 859 3894" → "971588593894". Pure. */
export function extractCallerDigits(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const beforeAt = raw.split('@')[0];
  const digits = beforeAt.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

/**
 * Parse a Vapi end-of-call-report webhook. Field locations vary across
 * Vapi versions (top-level vs `artifact.*`) — read both. Returns null
 * for any other message type. Pure — exported for tests.
 */
export function parseVapiEndOfCall(body: unknown): VapiCallReport | null {
  const message = (body as { message?: Record<string, unknown> })?.message;
  if (!message || message.type !== 'end-of-call-report') return null;
  const call = (message.call ?? {}) as Record<string, unknown>;
  const artifact = (message.artifact ?? {}) as Record<string, unknown>;
  const customer = (call.customer ?? {}) as Record<string, unknown>;

  const callId = typeof call.id === 'string' ? call.id : null;
  if (!callId) return null;

  const durationMs = typeof message.durationMs === 'number' ? message.durationMs
    : typeof message.durationSeconds === 'number' ? message.durationSeconds * 1000
    : null;

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

  return {
    callId,
    callerDigits: extractCallerDigits(customer.number ?? customer.sipUri ?? call.customerNumber),
    endedReason: str(message.endedReason),
    durationSeconds: durationMs !== null ? Math.round(durationMs / 1000) : null,
    summary: str(message.summary) ?? str(artifact.summary),
    transcript: str(message.transcript) ?? str(artifact.transcript),
    recordingUrl: str(message.recordingUrl) ?? str(artifact.recordingUrl) ?? str(artifact.recording),
  };
}

const TRANSCRIPT_CAP = 4000;

export type CallDirection = 'inbound' | 'outbound' | 'web';

/** Inbox-facing text for a completed voice call. Pure — exported for tests. */
export function formatCallLogMessage(r: VapiCallReport, direction: CallDirection = 'inbound'): string {
  const mins = r.durationSeconds !== null
    ? `${Math.floor(r.durationSeconds / 60)} min ${r.durationSeconds % 60} sec`
    : 'duration unknown';
  const label = direction === 'outbound' ? 'Outbound call (Lucy)' : 'Voice call';
  const lines = [`📞 ${label} — ${mins}${r.endedReason ? ` (${r.endedReason})` : ''}`];
  if (r.summary) lines.push('', `Summary: ${r.summary}`);
  if (r.recordingUrl) lines.push('', `Recording: ${r.recordingUrl}`);
  if (r.transcript) {
    const t = r.transcript.length > TRANSCRIPT_CAP
      ? `${r.transcript.slice(0, TRANSCRIPT_CAP)}…`
      : r.transcript;
    lines.push('', 'Transcript:', t);
  }
  return lines.join('\n');
}

/**
 * Voice-friendly rendering of KB passages: short, no markdown, ready
 * to be spoken. Pure.
 */
export function speakableKbAnswer(
  hits: Array<{ document_title: string; content: string }>,
): string {
  if (hits.length === 0) {
    return 'No knowledge-base entry covers this. Tell the caller you will confirm the detail with the team and someone will follow up — do not guess.';
  }
  const parts = hits.slice(0, 3).map((h) => `From "${h.document_title}": ${h.content}`);
  return `Answer ONLY from these passages, briefly and conversationally:\n${parts.join('\n---\n')}`;
}
