import { describe, expect, it } from 'vitest';
import { mayAutoSend } from './policy';

describe('mayAutoSend', () => {
  it('auto-sends confident FAQ intents', () => {
    expect(mayAutoSend('registration_help', 0.9)).toBe(true);
    expect(mayAutoSend('app_download', 0.8)).toBe(true);
  });
  it('never auto-sends sensitive or unknown intents', () => {
    expect(mayAutoSend('refund', 0.99)).toBe(false);
    expect(mayAutoSend('random_thing', 0.99)).toBe(false);
  });
  it('escalates low-confidence FAQ', () => {
    expect(mayAutoSend('pricing_info', 0.5)).toBe(false);
  });
});
