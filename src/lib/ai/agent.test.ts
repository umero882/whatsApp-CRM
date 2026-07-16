import { describe, expect, it } from 'vitest';
import { APP_INFO_BLOCK, extractChoicesFromText, stripCardNarration, stringifyHistoryMessage } from './agent';

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

describe('stringifyHistoryMessage — media', () => {
  it('renders the AI media summary with a kind prefix', () => {
    const s = stringifyHistoryMessage({
      sender_type: 'customer', content_type: 'image', content_text: null,
      ai_media_summary: 'Ethiopian passport for Almaz, expires 2028-04-15',
      created_at: '2026-07-11T00:00:00Z',
    } as never);
    expect(s).toContain('passport');
    expect(s).toContain('Almaz');
  });

  it('falls back to [content_type] when no text and no summary', () => {
    const s = stringifyHistoryMessage({
      sender_type: 'customer', content_type: 'image', content_text: null,
      ai_media_summary: null, created_at: '2026-07-11T00:00:00Z',
    } as never);
    expect(s).toBe('[image]');
  });
});

describe('extractChoicesFromText', () => {
  it('extracts the exact production failure: duties list with ▸ bullets', () => {
    const r = extractChoicesFromText(
      'What will be the main duties for the maid?\n▸ Childcare\n▸ Cooking\n▸ Elderly care\n▸ General housework',
    );
    expect(r).toEqual({
      body: 'What will be the main duties for the maid?',
      options: ['Childcare', 'Cooking', 'Elderly care', 'General housework'],
    });
  });

  it('extracts numbered and dashed lists', () => {
    expect(extractChoicesFromText('Live-in or live-out?\n1. Live-in\n2) Live-out')).toEqual({
      body: 'Live-in or live-out?',
      options: ['Live-in', 'Live-out'],
    });
    expect(extractChoicesFromText('Please choose:\n- Yes, alert me\n- Widen the search')).toEqual({
      body: 'Please choose:',
      options: ['Yes, alert me', 'Widen the search'],
    });
  });

  it('leaves normal replies and prose lists alone', () => {
    expect(extractChoicesFromText('Welcome to Ethiopian Maids 🌸 How can I help you today?')).toBeNull();
    // Single bullet — not a choice set.
    expect(extractChoicesFromText('Note:\n- We only place Ethiopian workers')).toBeNull();
    // Long lines are summaries (jobs/candidates), not option labels.
    expect(extractChoicesFromText(
      'Here are the openings I found:\n1. Nanny — Dubai, 1,400–1,600 AED/mo, live-in required\n2. Housekeeper — Abu Dhabi, 1,500 AED/mo, live-out preferred',
    )).toBeNull();
    // Bullets without a question/colon body — informational, keep as text.
    expect(extractChoicesFromText('We offer these services\n- Cleaning\n- Cooking')).toBeNull();
  });
});

describe('stringifyHistoryMessage — interactive choices rendering', () => {
  it('re-frames our persisted ▸ options as a tool artifact so models do not imitate it', () => {
    const out = stringifyHistoryMessage({
      sender_type: 'agent',
      content_type: 'interactive',
      content_text: 'Do you prefer a live-in or live-out maid?\n▸ Live-in\n▸ Live-out',
      created_at: '2026-07-12T08:00:00Z',
    });
    expect(out).toBe(
      '[you sent tappable options via reply_with_choices] Do you prefer a live-in or live-out maid? [options: Live-in | Live-out]',
    );
  });

  it('leaves customer messages and plain agent text untouched', () => {
    expect(stringifyHistoryMessage({
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Dubai',
      created_at: '2026-07-12T08:00:00Z',
    })).toBe('Dubai');
  });
});

describe('extractChoicesFromText — prose option lists', () => {
  it('extracts the exact production failure: "Options include A, B, C, or D."', () => {
    const r = extractChoicesFromText(
      "Could you please let me know the main duties for the maid for your brother's family? Options include Childcare, Cooking, Elderly care, or General housework.",
    );
    expect(r).toEqual({
      body: "Could you please let me know the main duties for the maid for your brother's family?",
      options: ['Childcare', 'Cooking', 'Elderly care', 'General housework'],
    });
  });

  it('extracts "choose between" and "options are" phrasings', () => {
    expect(extractChoicesFromText('Do you prefer live-in or live-out? You can choose between Live-in and Live-out.'))
      .toEqual({ body: 'Do you prefer live-in or live-out?', options: ['Live-in', 'Live-out'] });
    expect(extractChoicesFromText('Which emirate are you in? The options are Dubai, Abu Dhabi, or Sharjah.'))
      .toEqual({ body: 'Which emirate are you in?', options: ['Dubai', 'Abu Dhabi', 'Sharjah'] });
  });

  it('ignores prose enumerations that are not answer options', () => {
    // No question in the body — informational sentence.
    expect(extractChoicesFromText('Our options include cleaning, cooking, and childcare services.')).toBeNull();
    // Long items — benefits blurb, not option labels.
    expect(extractChoicesFromText(
      'What do you think? Options include a fully furnished private room in the villa, or a monthly transport allowance of 300 AED.',
    )).toBeNull();
    // Enumeration mid-text, not the trailing sentence.
    expect(extractChoicesFromText('Options include Childcare or Cooking. When do you need her to start?')).toBeNull();
  });
});

describe('APP_INFO_BLOCK — iOS launch copy (regression: iOS app went live 2026-07-16)', () => {
  it('no longer claims the iPhone app is "coming soon"', () => {
    expect(APP_INFO_BLOCK).not.toMatch(/coming soon/i);
  });

  it('states both stores are live', () => {
    expect(APP_INFO_BLOCK).toMatch(/Google Play/);
    expect(APP_INFO_BLOCK).toMatch(/App Store/);
    expect(APP_INFO_BLOCK).toMatch(/Android[^.]*live/i);
    expect(APP_INFO_BLOCK).toMatch(/iPhone[^.]*live/i);
  });

  it('tells the model how to pick the platform argument', () => {
    expect(APP_INFO_BLOCK).toMatch(/platform/i);
    expect(APP_INFO_BLOCK).toMatch(/'ios'/);
    expect(APP_INFO_BLOCK).toMatch(/'android'/);
    expect(APP_INFO_BLOCK).toMatch(/Are you on iPhone or Android/i);
  });

  it('still forbids collecting registration details in chat and pasting the raw store URL', () => {
    expect(APP_INFO_BLOCK).toMatch(/NEVER collect registration details over chat/i);
    expect(APP_INFO_BLOCK).toMatch(/NEVER paste the store URL as plain text/i);
    expect(APP_INFO_BLOCK).not.toMatch(/https?:\/\//);
  });

  it('still tells the model send_app_download_card is available in every stage', () => {
    expect(APP_INFO_BLOCK).toMatch(/send_app_download_card \(available\s+in every stage\)/);
  });
});
