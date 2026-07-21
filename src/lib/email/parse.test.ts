import { describe, expect, it } from 'vitest';
import { parseEmail } from './parse';

const RAW = [
  'From: Jane Doe <jane@example.com>',
  'To: support@ethiopianmaids.com',
  'Subject: How do I register?',
  'Message-ID: <abc123@mail.example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello, how do I sign up as a sponsor?',
].join('\r\n');

const toB64Url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('parseEmail', () => {
  it('extracts sender, subject, body, message-id, alias', async () => {
    const p = await parseEmail(toB64Url(RAW));
    expect(p.fromEmail).toBe('jane@example.com');
    expect(p.subject).toBe('How do I register?');
    expect(p.messageId).toBe('abc123@mail.example.com');
    expect(p.toAddresses).toContain('support@ethiopianmaids.com');
    expect(p.text).toContain('sign up as a sponsor');
    expect(p.autoSubmitted).toBe(false);
  });

  it('flags auto-submitted / bulk mail', async () => {
    const raw = RAW.replace('Subject:', 'Auto-Submitted: auto-replied\r\nSubject:');
    const p = await parseEmail(toB64Url(raw));
    expect(p.autoSubmitted).toBe(true);
  });
});
