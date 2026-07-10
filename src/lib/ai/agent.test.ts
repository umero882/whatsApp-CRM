import { describe, expect, it } from 'vitest';
import { stripCardNarration } from './agent';

describe('stripCardNarration', () => {
  it('leaves normal replies untouched', () => {
    const r = stripCardNarration('Welcome to Ethiopian Maids 🌸 How can I help you today?');
    expect(r.mentioned).toBe(false);
    expect(r.cleaned).toBe('Welcome to Ethiopian Maids 🌸 How can I help you today?');
  });

  it('strips the exact production narration seen with gpt-4o-mini', () => {
    const r = stripCardNarration(
      'To register, please download our official app from Google Play. Tap the button below to get started 🌸. \n\n(send_app_download_card)',
    );
    expect(r.mentioned).toBe(true);
    expect(r.cleaned).toBe(
      'To register, please download our official app from Google Play. Tap the button below to get started 🌸.',
    );
    expect(r.cleaned).not.toMatch(/send_app_download_card/i);
  });

  it('handles inline and call-style mentions', () => {
    for (const text of [
      'Let me send that: send_app_download_card()',
      'calling send_app_download_card now',
      'Here you go [send_app_download_card]',
    ]) {
      const r = stripCardNarration(text);
      expect(r.mentioned).toBe(true);
      expect(r.cleaned).not.toMatch(/send_app_download_card/i);
    }
  });

  it('returns empty cleaned text when the reply was only the narration', () => {
    const r = stripCardNarration('(send_app_download_card)');
    expect(r.mentioned).toBe(true);
    expect(r.cleaned).toBe('');
  });
});
