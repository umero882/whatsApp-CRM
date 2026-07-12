import { describe, expect, it } from 'vitest';
import { extractCallerDigits, formatCallLogMessage, parseVapiEndOfCall, parseVapiToolCalls, speakableKbAnswer, vapiResult } from './vapi-tools';

describe('parseVapiToolCalls', () => {
  it('parses the documented tool-calls shape with string arguments', () => {
    const calls = parseVapiToolCalls({
      message: {
        type: 'tool-calls',
        toolCallList: [
          { id: 'tc1', function: { name: 'search_knowledge_base', arguments: '{"query":"visa process"}' } },
        ],
      },
    });
    expect(calls).toEqual([{ id: 'tc1', name: 'search_knowledge_base', args: { query: 'visa process' } }]);
  });

  it('tolerates object arguments and the toolCalls field name', () => {
    const calls = parseVapiToolCalls({
      message: {
        type: 'tool-calls',
        toolCalls: [{ id: 'tc2', function: { name: 'search_maids', arguments: { live_in: true } } }],
      },
    });
    expect(calls).toEqual([{ id: 'tc2', name: 'search_maids', args: { live_in: true } }]);
  });

  it('returns [] for status updates and malformed bodies', () => {
    expect(parseVapiToolCalls({ message: { type: 'status-update' } })).toEqual([]);
    expect(parseVapiToolCalls({})).toEqual([]);
    expect(parseVapiToolCalls(null)).toEqual([]);
    expect(parseVapiToolCalls({ message: { type: 'tool-calls', toolCallList: [{ function: { name: 'x' } }] } })).toEqual([]);
  });
});

describe('vapiResult', () => {
  it('passes strings through and stringifies objects', () => {
    expect(vapiResult('a', 'hello')).toEqual({ toolCallId: 'a', result: 'hello' });
    expect(vapiResult('b', { ok: true })).toEqual({ toolCallId: 'b', result: '{"ok":true}' });
  });
});

describe('speakableKbAnswer', () => {
  it('formats passages for speech with source attribution', () => {
    const out = speakableKbAnswer([
      { document_title: 'UAE — rules', content: 'One paid rest day per week.' },
    ]);
    expect(out).toContain('From "UAE — rules": One paid rest day per week.');
    expect(out).toContain('ONLY from these passages');
  });

  it('empty result instructs the model to admit the gap', () => {
    expect(speakableKbAnswer([])).toContain('do not guess');
  });
});

describe('extractCallerDigits', () => {
  it('extracts digits from SIP URIs and formatted numbers', () => {
    expect(extractCallerDigits('sip:971588593894@sip.vapi.ai')).toBe('971588593894');
    expect(extractCallerDigits('+971 58 859 3894')).toBe('971588593894');
  });

  it('rejects junk and too-short values', () => {
    expect(extractCallerDigits('anonymous')).toBeNull();
    expect(extractCallerDigits('12345')).toBeNull();
    expect(extractCallerDigits(undefined)).toBeNull();
  });
});

describe('parseVapiEndOfCall', () => {
  it('parses a top-level-fields report', () => {
    const r = parseVapiEndOfCall({
      message: {
        type: 'end-of-call-report',
        endedReason: 'customer-ended-call',
        durationMs: 192_000,
        summary: 'Caller asked about fees.',
        transcript: 'AI: Hello...\nUser: Hi...',
        recordingUrl: 'https://storage.vapi.ai/rec.wav',
        call: { id: 'call_1', customer: { number: '+971585868560' } },
      },
    });
    expect(r).toEqual({
      callId: 'call_1',
      callerDigits: '971585868560',
      endedReason: 'customer-ended-call',
      durationSeconds: 192,
      summary: 'Caller asked about fees.',
      transcript: 'AI: Hello...\nUser: Hi...',
      recordingUrl: 'https://storage.vapi.ai/rec.wav',
    });
  });

  it('falls back to artifact fields and SIP caller uris', () => {
    const r = parseVapiEndOfCall({
      message: {
        type: 'end-of-call-report',
        call: { id: 'call_2', customer: { sipUri: 'sip:971588593894@sip.vapi.ai' } },
        artifact: { transcript: 'T', recordingUrl: 'https://r', summary: 'S' },
      },
    });
    expect(r?.callerDigits).toBe('971588593894');
    expect(r?.transcript).toBe('T');
    expect(r?.recordingUrl).toBe('https://r');
    expect(r?.summary).toBe('S');
    expect(r?.durationSeconds).toBeNull();
  });

  it('returns null for other message types or missing call id', () => {
    expect(parseVapiEndOfCall({ message: { type: 'status-update' } })).toBeNull();
    expect(parseVapiEndOfCall({ message: { type: 'end-of-call-report', call: {} } })).toBeNull();
  });
});

describe('formatCallLogMessage', () => {
  it('renders duration, summary, recording, and capped transcript', () => {
    const text = formatCallLogMessage({
      callId: 'c',
      callerDigits: '971585868560',
      endedReason: 'customer-ended-call',
      durationSeconds: 192,
      summary: 'Asked about fees.',
      transcript: 'X'.repeat(5000),
      recordingUrl: 'https://r',
    });
    expect(text).toContain('📞 Voice call — 3 min 12 sec (customer-ended-call)');
    expect(text).toContain('Summary: Asked about fees.');
    expect(text).toContain('Recording: https://r');
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(4400);
  });
});
