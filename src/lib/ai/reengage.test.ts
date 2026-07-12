import { describe, expect, it } from 'vitest';
import {
  buildReengageNudge,
  evaluateDormantConversation,
  REENGAGE_MAX_SILENCE_MS,
  REENGAGE_MIN_SILENCE_MS,
  type DormancyInput,
} from './reengage';

const NOW = new Date('2026-07-12T12:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;

function base(overrides: Partial<DormancyInput> = {}): DormancyInput {
  return {
    now: NOW,
    lastMessageSender: 'agent',
    lastMessageAgentKind: 'ai',
    lastCustomerAt: NOW - 8 * HOUR,
    aiPausedUntil: null,
    lastReengageAt: null,
    ...overrides,
  };
}

describe('evaluateDormantConversation', () => {
  it('is eligible for an AI-owned thread silent 8h with no prior nudge', () => {
    expect(evaluateDormantConversation(base())).toEqual({ eligible: true });
  });

  it('skips when the customer spoke last (agent owes a reply)', () => {
    expect(evaluateDormantConversation(base({ lastMessageSender: 'customer' })))
      .toEqual({ eligible: false, reason: 'customer_turn_pending' });
  });

  it('skips when a human wrote the last message', () => {
    expect(evaluateDormantConversation(base({ lastMessageAgentKind: 'human' })))
      .toEqual({ eligible: false, reason: 'human_owns_thread' });
  });

  it('skips when the customer never wrote', () => {
    expect(evaluateDormantConversation(base({ lastCustomerAt: null })))
      .toEqual({ eligible: false, reason: 'never_heard_from_customer' });
  });

  it('skips when silence is under the minimum', () => {
    expect(evaluateDormantConversation(base({ lastCustomerAt: NOW - REENGAGE_MIN_SILENCE_MS + 1000 })))
      .toEqual({ eligible: false, reason: 'too_recent' });
  });

  it('skips when the 24h window is (nearly) closed', () => {
    expect(evaluateDormantConversation(base({ lastCustomerAt: NOW - REENGAGE_MAX_SILENCE_MS - 1000 })))
      .toEqual({ eligible: false, reason: 'window_closed' });
  });

  it('skips while a human-takeover pause is active, allows after it lapses', () => {
    expect(evaluateDormantConversation(base({ aiPausedUntil: NOW + HOUR })))
      .toEqual({ eligible: false, reason: 'ai_paused' });
    expect(evaluateDormantConversation(base({ aiPausedUntil: NOW - HOUR })))
      .toEqual({ eligible: true });
  });

  it('skips when this lull was already nudged, allows after a newer customer message', () => {
    // Nudge happened AFTER the customer's last message → same lull.
    expect(evaluateDormantConversation(base({ lastReengageAt: NOW - 7 * HOUR })))
      .toEqual({ eligible: false, reason: 'already_nudged' });
    // Customer wrote again after the old nudge → new lull, nudge allowed.
    expect(evaluateDormantConversation(base({ lastReengageAt: NOW - 20 * HOUR })))
      .toEqual({ eligible: true });
  });
});

describe('buildReengageNudge', () => {
  it('English includes name and business, stays short', () => {
    const msg = buildReengageNudge('en', 'Ahmed', 'Ethiopian Maids');
    expect(msg).toContain('Hi Ahmed! 👋');
    expect(msg).toContain('Ethiopian Maids');
    expect(msg.length).toBeLessThan(250);
  });

  it('falls back gracefully with no name and no business', () => {
    const msg = buildReengageNudge('en', null, null);
    expect(msg).toContain('Hi! 👋');
    expect(msg).toContain('Ethiopian Maids');
  });

  it.each(['ar', 'am'] as const)('%s copy is localized', (lang) => {
    const msg = buildReengageNudge(lang, null, 'Ethiopian Maids');
    expect(msg).not.toMatch(/checking in/);
    expect(msg).toContain('Ethiopian Maids');
  });
});
