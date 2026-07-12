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
