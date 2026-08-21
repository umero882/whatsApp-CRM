import { describe, expect, it } from 'vitest';
import {
  APP_INFO_BLOCK,
  extractChoicesFromText,
  shouldForceAppCard,
  STAGE_GUIDANCE,
  stringifyHistoryMessage,
  stripCardNarration,
  type HistoryRow,
} from './agent';

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

  // Production incident 2026-07-17: the model replied with the pointer
  // sentence in PLAIN LANGUAGE (no tool name) and never called the tool, so
  // the guard missed it and no card was sent — the customer saw only the
  // sentence. These natural-language pointers must now count as narration.
  it.each([
    'Tap the button above to get our official app 🌸',
    'Tap the button below to download the app.',
    'You can download our app to register — tap the button above 🌸',
  ])('detects plain-language card pointers with no tool name: %s', (text) => {
    const r = stripCardNarration(text);
    expect(r.mentioned).toBe(true);
    // Nothing to strip — the sentence itself is a fine reply to show.
    expect(r.cleaned).toBe(text);
  });

  it('does not fire on unrelated mentions of an app', () => {
    for (const text of [
      'Great — your application has been received!',
      'The interview happens over a video app link we will send.',
      'Welcome to Ethiopian Maids 🌸 How can I help you today?',
    ]) {
      expect(stripCardNarration(text).mentioned).toBe(false);
    }
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

  // The block is hard-wrapped for readability, so a phrase can straddle a
  // newline. Match against a whitespace-collapsed copy: re-wrapping the
  // prompt must never silently disarm a policy assertion.
  const flat = APP_INFO_BLOCK.replace(/\s+/g, ' ');

  it('tells the model how to pick the platform argument', () => {
    expect(flat).toMatch(/platform/i);
    expect(flat).toMatch(/'ios'/);
    expect(flat).toMatch(/'android'/);
  });

  // Regression: the model was seen in production passing platform:"android"
  // unprompted for an iPhone user. Asking was tried and ignored, so the block
  // must now tell it to OMIT platform and let the link route on the device.
  it('tells the model to omit platform rather than guess or ask', () => {
    expect(flat).toMatch(/OMIT platform/i);
    expect(flat).toMatch(/do NOT guess/i);
    expect(flat).not.toMatch(/Are you on iPhone or Android/i);
    expect(flat).not.toMatch(/Defaults to android/i);
  });

  it('still forbids collecting registration details in chat and pasting the raw store URL', () => {
    expect(flat).toMatch(/NEVER collect registration details over chat/i);
    expect(flat).toMatch(/NEVER paste the store URL as plain text/i);
    expect(APP_INFO_BLOCK).not.toMatch(/https?:\/\//);
  });

  it('still tells the model send_app_download_card is available in every stage', () => {
    expect(flat).toMatch(/send_app_download_card \(available in every stage\)/);
  });
});

// ════════════════════════════════════════════════════════════════════
// shouldForceAppCard
//
// Regression for the 2026-08-22 audit: across 58 conversations the app
// card was sent on the FIRST agent reply exactly ZERO times. The model
// always asked "registered or new?" first (reply_with_choices, which
// ENDS the turn), and ~30% of customers never answered — so they never
// saw the card at all. The card is now sent server-side and these tests
// pin the trigger.
// ════════════════════════════════════════════════════════════════════

const cust = (text: string): HistoryRow => ({
  sender_type: 'customer', content_type: 'text', content_text: text,
  created_at: '2026-08-22T00:00:00Z',
});
const bot = (text: string): HistoryRow => ({
  sender_type: 'agent', agent_kind: 'ai', content_type: 'text', content_text: text,
  created_at: '2026-08-22T00:00:01Z',
});

describe('shouldForceAppCard', () => {
  it('fires on first contact when the opener already states hire intent', () => {
    const opener = 'Hello! I would like to inquire about hiring a maid.';
    expect(shouldForceAppCard([cust(opener)], 'sponsor', opener)).toBe(true);
  });

  it('fires on first contact for a job seeker (production convo dfc13024)', () => {
    const opener = 'Hello! I want job in Kuwait';
    expect(shouldForceAppCard([cust(opener)], 'job_seeker', opener)).toBe(true);
  });

  it('fires on an explicit register/download ask even when intent is unknown', () => {
    for (const t of ['I want to register', 'how do I sign up?', 'send me the app link', 'تسجيل']) {
      expect(shouldForceAppCard([cust(t)], 'unknown', t)).toBe(true);
    }
  });

  it('does NOT fire on a vague opener — that still gets the triage question', () => {
    const opener = 'Hello! Can I get more info on this?';
    expect(shouldForceAppCard([cust(opener)], 'unknown', opener)).toBe(false);
  });

  it('does NOT fire on a bare greeting', () => {
    expect(shouldForceAppCard([cust('Hi')], 'unknown', 'Hi')).toBe(false);
  });

  it('fires when the customer answers the triage with "I\'m new"', () => {
    const history = [
      cust('Hello! Can I get more info on this?'),
      bot('Are you already registered with us, or new here?'),
      cust("I'm new here"),
    ];
    expect(shouldForceAppCard(history, 'unknown', "I'm new here")).toBe(true);
  });

  it('fires on the free-text equivalents of the "I\'m new" option', () => {
    for (const t of ['new here', 'I am new', 'not registered', 'first time']) {
      expect(shouldForceAppCard([cust('hi'), bot('registered or new?'), cust(t)], 'unknown', t)).toBe(true);
    }
  });

  it('does NOT fire for an existing customer answering the triage', () => {
    const history = [cust('hi'), bot('Are you already registered with us, or new here?'), cust('Existing customer')];
    expect(shouldForceAppCard(history, 'unknown', 'Existing customer')).toBe(false);
  });

  it('never sends a second card once one is in the conversation', () => {
    const history = [
      cust('I want to hire a maid'),
      bot('[Official app download card]'),
      bot('Tap the button above 🌸'),
      cust('I want to hire a maid'),
    ];
    expect(shouldForceAppCard(history, 'sponsor', 'I want to hire a maid')).toBe(false);
  });

  it('recognises the legacy long-form card row too', () => {
    const history = [
      cust('I want to hire a maid'),
      bot('[Official app download card] This is the official Ethiopian Maids app on Google Play.'),
      cust('I want to hire a maid'),
    ];
    expect(shouldForceAppCard(history, 'sponsor', 'I want to hire a maid')).toBe(false);
  });

  it('does NOT fire mid-conversation for an already-greeted customer with no new signal', () => {
    const history = [cust('hi'), bot('Welcome to Ethiopian Maids 🌸'), cust('which emirate do you cover?')];
    expect(shouldForceAppCard(history, 'unknown', 'which emirate do you cover?')).toBe(false);
  });
});

describe('STAGE_GUIDANCE — the card leads, the triage follows (regression 2026-08-22)', () => {
  it('GREETING tells the model to send the card before asking anything', () => {
    const g = STAGE_GUIDANCE.GREETING;
    expect(g).toMatch(/send_app_download_card/);
    expect(g).toMatch(/Do NOT ask "are you registered\?" first/i);
    // The card instruction must come BEFORE the "just welcome them" case.
    expect(g.indexOf('send_app_download_card')).toBeLessThan(g.indexOf('CASE B'));
  });

  it('DISCOVERY leads with the card, not with the triage question', () => {
    const g = STAGE_GUIDANCE.DISCOVERY;
    expect(g.indexOf('send_app_download_card')).toBeLessThan(g.indexOf('reply_with_choices'));
  });
});

describe('shouldForceAppCard — non-Latin scripts (regression: \b is ASCII-only in JS)', () => {
  it('matches the Arabic and Amharic register/app asks', () => {
    for (const t of ['تسجيل', 'اريد التطبيق', 'መተግበሪያ']) {
      expect(shouldForceAppCard([cust(t)], 'unknown', t)).toBe(true);
    }
  });

  it('matches the Arabic and Amharic "I am new" triage answers', () => {
    for (const t of ['جديد', 'አዲስ']) {
      expect(shouldForceAppCard([cust('hi'), bot('registered or new?'), cust(t)], 'unknown', t)).toBe(true);
    }
  });
});
