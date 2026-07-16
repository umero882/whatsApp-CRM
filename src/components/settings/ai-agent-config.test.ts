import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from './ai-agent-config';

describe('DEFAULT_SYSTEM_PROMPT — iOS launch copy (regression: iOS app went live 2026-07-16)', () => {
  it('no longer claims the iPhone app is "coming soon"', () => {
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/coming soon/i);
  });

  it('states both stores are live', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Google Play/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/App Store/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Android:\s*live/i);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/iPhone:\s*live/i);
  });

  it('tells the model how to pick the platform argument', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/platform/i);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/'ios'/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/'android'/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Are you on iPhone or Android/i);
  });

  it('still forbids collecting registration details in chat and pasting the raw store URL', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/NEVER collect registration details over chat/i);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/NEVER paste the\s+store URL as plain text/i);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/https?:\/\//);
  });
});
