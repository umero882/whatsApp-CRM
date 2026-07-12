import { describe, expect, it } from 'vitest';
import { parseVapiToolCalls, speakableKbAnswer, vapiResult } from './vapi-tools';

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
