import { describe, expect, it } from 'vitest';
import {
  APP_PLAY_STORE_URL,
  buildAppDownloadCard,
  buildEscalationForward,
} from './ethiopian-maids';

describe('buildEscalationForward', () => {
  it('includes name, normalized number, reason, issue, and reply link', () => {
    const msg = buildEscalationForward({
      customerName: 'Muna Kedir',
      customerPhone: '+971 58 586 8560',
      reason: 'job application needs human follow-up',
      issueSummary: 'Job seeker in UAE, wants cleaning work, available immediately.',
      urgent: false,
    });
    expect(msg).toContain('🟠 Human needed');
    expect(msg).toContain('Customer: Muna Kedir (+971585868560)');
    expect(msg).toContain('Reason: job application needs human follow-up');
    expect(msg).toContain('Issue: Job seeker in UAE, wants cleaning work, available immediately.');
    expect(msg).toContain('https://wa.me/971585868560');
  });

  it('marks urgent escalations and tolerates missing name/summary', () => {
    const msg = buildEscalationForward({
      customerName: null,
      customerPhone: '971526799960',
      reason: 'customer is angry',
      issueSummary: null,
      urgent: true,
    });
    expect(msg).toContain('🔴 URGENT — human needed');
    expect(msg).toContain('Customer: Unknown (+971526799960)');
    expect(msg).not.toContain('Issue:');
    expect(msg).toContain('https://wa.me/971526799960');
  });
});

describe('buildAppDownloadCard', () => {
  it.each(['en', 'ar', 'am'] as const)('%s card points at the official store with a valid button', (lang) => {
    const card = buildAppDownloadCard(lang);
    expect(card.url).toBe(APP_PLAY_STORE_URL);
    expect(card.url).toContain('play.google.com/store/apps/details?id=com.ethiopianmaids.app');
    expect(card.headerImageUrl).toMatch(/^https:\/\/play\.google\.com\/.*badge.*\.png$/);
    // Meta cta_url limits: display_text ≤20 chars, footer ≤60 chars.
    expect(card.buttonText.length).toBeGreaterThan(0);
    expect(card.buttonText.length).toBeLessThanOrEqual(20);
    expect(card.footerText.length).toBeLessThanOrEqual(60);
    expect(card.bodyText.length).toBeGreaterThan(20);
    expect(card.bodyText.length).toBeLessThanOrEqual(1024);
  });
});
