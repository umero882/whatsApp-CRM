import { describe, expect, it } from 'vitest';
import {
  CHANNELS,
  ChannelNotImplementedError,
  filterToolsForChannel,
  isChannel,
  sendChannelText,
} from './router';

const TOOLS = [
  { name: 'search_maids' },
  { name: 'reply_with_choices' },
  { name: 'send_maid_cards' },
  { name: 'send_app_download_card' },
  { name: 'search_knowledge_base' },
  { name: 'escalate_to_human' },
];

describe('filterToolsForChannel', () => {
  it('keeps everything on whatsapp', () => {
    expect(filterToolsForChannel(TOOLS, 'whatsapp')).toHaveLength(TOOLS.length);
  });

  it.each(['instagram', 'messenger', 'telegram'] as const)(
    'strips WhatsApp-surface tools on %s but keeps data/knowledge tools',
    (ch) => {
      const names = filterToolsForChannel(TOOLS, ch).map((t) => t.name);
      expect(names).toEqual(['search_maids', 'search_knowledge_base', 'escalate_to_human']);
    },
  );
});

describe('isChannel', () => {
  it('accepts known channels and rejects junk', () => {
    expect(isChannel('whatsapp')).toBe(true);
    expect(isChannel('telegram')).toBe(true);
    expect(isChannel('sms')).toBe(false);
    expect(isChannel(null)).toBe(false);
  });
});

describe('sendChannelText', () => {
  it('throws ChannelNotImplementedError for unwired channels', async () => {
    await expect(sendChannelText({ channel: 'instagram', to: 'igsid', text: 'hi' }))
      .rejects.toBeInstanceOf(ChannelNotImplementedError);
  });

  it('requires whatsapp credentials for whatsapp sends', async () => {
    await expect(sendChannelText({ channel: 'whatsapp', to: '+971585868560', text: 'hi' }))
      .rejects.toThrow(/credentials missing/);
  });
});

describe('channels/router email', () => {
  it('email is a known channel', () => {
    expect(CHANNELS).toContain('email');
    expect(isChannel('email')).toBe(true);
  });

  it('filters WhatsApp-only tools out for email', () => {
    const tools = [{ name: 'send_maid_cards' }, { name: 'search_knowledge_base' }];
    const kept = filterToolsForChannel(tools, 'email').map((t) => t.name);
    expect(kept).toEqual(['search_knowledge_base']);
  });
});
