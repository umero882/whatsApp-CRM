import { describe, expect, it } from 'vitest';
import { resolveChannelDestination } from './agent';

describe('resolveChannelDestination', () => {
  it('uses email external_id for email channel', () => {
    expect(resolveChannelDestination('email', { phone: null, external_id: 'jane@example.com' }))
      .toBe('jane@example.com');
  });
  it('uses phone for whatsapp', () => {
    expect(resolveChannelDestination('whatsapp', { phone: '+971...', external_id: null }))
      .toBe('+971...');
  });
});
