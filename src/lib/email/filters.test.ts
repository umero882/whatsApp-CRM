import { describe, expect, it } from 'vitest';
import { shouldDropEmail } from './filters';
import type { ParsedEmail } from './parse';

const base: ParsedEmail = {
  messageId: 'x@y', fromEmail: 'jane@example.com', fromName: 'Jane', replyTo: null,
  toAddresses: ['support@ethiopianmaids.com'], subject: 'hi', text: 'help me register',
  references: null, autoSubmitted: false,
};

describe('shouldDropEmail', () => {
  it('keeps a normal customer email', () => {
    expect(shouldDropEmail(base).drop).toBe(false);
  });
  it('drops auto-submitted', () => {
    expect(shouldDropEmail({ ...base, autoSubmitted: true }).drop).toBe(true);
  });
  it('drops mailer-daemon / no-reply senders', () => {
    expect(shouldDropEmail({ ...base, fromEmail: 'mailer-daemon@google.com' }).drop).toBe(true);
    expect(shouldDropEmail({ ...base, fromEmail: 'no-reply@foo.com' }).drop).toBe(true);
  });
  it('drops our own address (loop)', () => {
    expect(shouldDropEmail({ ...base, fromEmail: 'nextechlabs.dev@gmail.com' }).drop).toBe(true);
  });
});
