import { describe, expect, it } from 'vitest';
import {
  buildVapiOutboundBody,
  normalizeDialNumber,
  outboundFirstMessage,
} from './outbound';

describe('normalizeDialNumber', () => {
  it('normalizes formatted, 00-prefixed, and already-clean numbers', () => {
    expect(normalizeDialNumber('+971 58 859-3894')).toBe('+971588593894');
    expect(normalizeDialNumber('00971588593894')).toBe('+971588593894');
    expect(normalizeDialNumber('16893459115')).toBe('+16893459115');
  });

  it('rejects garbage, short, and overlong input', () => {
    expect(normalizeDialNumber('call me')).toBeNull();
    expect(normalizeDialNumber('12345')).toBeNull();
    expect(normalizeDialNumber('1'.repeat(16))).toBeNull();
    expect(normalizeDialNumber(null)).toBeNull();
    expect(normalizeDialNumber(42)).toBeNull();
  });
});

describe('outboundFirstMessage', () => {
  it('greets by name and states the objective', () => {
    const msg = outboundFirstMessage('your maid request from yesterday', 'Ahmed');
    expect(msg).toContain('Hello Ahmed!');
    expect(msg).toContain('Lucy calling from Ethiopian Maids');
    expect(msg).toContain("I'm calling about your maid request from yesterday.");
  });

  it('stays generic without name or objective', () => {
    const msg = outboundFirstMessage(null, null);
    expect(msg).toContain('Hello!');
    expect(msg).not.toContain('calling about');
  });
});

describe('buildVapiOutboundBody', () => {
  it('builds the /call payload with overrides', () => {
    const body = buildVapiOutboundBody({
      assistantId: 'asst-1',
      phoneNumberId: 'pn-1',
      number: '+971588593894',
      objective: 'confirm the interview',
      contactName: 'Sara',
    });
    expect(body.assistantId).toBe('asst-1');
    expect(body.phoneNumberId).toBe('pn-1');
    expect(body.customer).toEqual({ number: '+971588593894' });
    const overrides = body.assistantOverrides as {
      firstMessage: string;
      variableValues: Record<string, string>;
    };
    expect(overrides.firstMessage).toContain('Sara');
    expect(overrides.firstMessage).toContain('confirm the interview');
    expect(overrides.variableValues.call_direction).toBe('outbound');
    expect(overrides.variableValues.call_objective).toBe('confirm the interview');
  });

  it('falls back to general follow-up when no objective given', () => {
    const body = buildVapiOutboundBody({
      assistantId: 'a',
      phoneNumberId: 'p',
      number: '+16893459115',
    });
    const overrides = body.assistantOverrides as { variableValues: Record<string, string> };
    expect(overrides.variableValues.call_objective).toBe('general follow-up');
  });
});
