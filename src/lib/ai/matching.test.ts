import { describe, expect, it } from 'vitest';
import {
  buildJobAlertWhere,
  buildMaidAlertWhere,
  buildMatchNotification,
  isMetaWindowClosedError,
  normalizeAlertCriteria,
  summarizeJobMatch,
  summarizeMaidMatch,
  type AlertJobRow,
  type AlertMaidRow,
} from './matching';

const SINCE = '2026-07-10T00:00:00.000Z';

describe('normalizeAlertCriteria', () => {
  it('keeps sponsor fields, dedupes arrays, clamps numbers', () => {
    const c = normalizeAlertCriteria('sponsor', {
      live_in: true,
      languages: ['English', 'English', ' Arabic '],
      skills: ['childcare', '', 'cooking'],
      min_experience_years: 200,
      max_salary_aed: 1500,
      country: 'UAE', // maid-side field — must be dropped
    });
    expect(c).toEqual({
      live_in: true,
      languages: ['English', 'Arabic'],
      skills: ['childcare', 'cooking'],
      min_experience_years: 40,
      max_salary_aed: 1500,
    });
  });

  it('keeps maid fields and drops sponsor-side fields', () => {
    const c = normalizeAlertCriteria('maid', {
      country: '  UAE ',
      city: 'Dubai',
      live_in: false,
      maid_experience_years: 3,
      skills: ['cooking'], // sponsor-side — dropped
      max_salary_aed: 2000, // sponsor-side — dropped
    });
    expect(c).toEqual({
      live_in: false,
      country: 'UAE',
      city: 'Dubai',
      maid_experience_years: 3,
    });
  });

  it('returns an empty object for garbage input', () => {
    expect(normalizeAlertCriteria('sponsor', {
      languages: 'English', // not an array
      min_experience_years: 'lots',
      live_in: 'yes',
    })).toEqual({});
  });
});

describe('buildMaidAlertWhere', () => {
  it('always includes availability, approval, and the watermark', () => {
    const where = buildMaidAlertWhere({}, SINCE);
    expect(where).toEqual({
      availability_status: { _eq: 'available' },
      is_approved: { _eq: true },
      updated_at: { _gt: SINCE },
    });
  });

  it('maps criteria and merges languages + skills into one _or', () => {
    const where = buildMaidAlertWhere(
      {
        live_in: true,
        min_experience_years: 2,
        max_salary_aed: 1600,
        languages: ['English'],
        skills: ['childcare', 'cooking'],
      },
      SINCE,
    );
    expect(where.live_in_preference).toEqual({ _eq: true });
    expect(where.experience_years).toEqual({ _gte: 2 });
    expect(where.preferred_salary_max).toEqual({ _lte: 1600 });
    expect(where._or).toEqual([
      { languages: { _contains: ['English'] } },
      { skills: { _contains: ['childcare'] } },
      { skills: { _contains: ['cooking'] } },
    ]);
  });
});

describe('buildJobAlertWhere', () => {
  it('always includes active status and the watermark', () => {
    expect(buildJobAlertWhere({}, SINCE)).toEqual({
      status: { _eq: 'active' },
      created_at: { _gt: SINCE },
    });
  });

  it('maps maid-side criteria', () => {
    const where = buildJobAlertWhere(
      { country: 'UAE', city: 'Dubai', live_in: true, maid_experience_years: 4 },
      SINCE,
    );
    expect(where.country).toEqual({ _ilike: '%UAE%' });
    expect(where.city).toEqual({ _ilike: '%Dubai%' });
    expect(where.live_in_required).toEqual({ _eq: true });
    expect(where.minimum_experience_years).toEqual({ _lte: 4 });
  });
});

describe('summarizeMaidMatch', () => {
  it('formats a full row as one bullet line', () => {
    const row: AlertMaidRow = {
      id: 'm1',
      first_name: 'Meron',
      full_name: 'Meron T.',
      nationality: 'Ethiopian',
      country: 'Ethiopia',
      experience_years: 4,
      languages: ['English'],
      skills: ['childcare', 'cooking', 'cleaning', 'ironing'],
      preferred_salary_min: 1300,
      preferred_salary_max: 1500,
      preferred_currency: 'AED',
    };
    const line = summarizeMaidMatch(row);
    expect(line).toBe('• Meron — Ethiopian · 4 yrs experience · childcare, cooking, cleaning · 1,300–1,500 AED/mo');
  });

  it('tolerates sparse rows', () => {
    const line = summarizeMaidMatch({
      id: 'm2',
      first_name: null,
      full_name: null,
      nationality: null,
      country: null,
      experience_years: null,
      languages: null,
      skills: null,
      preferred_salary_min: null,
      preferred_salary_max: null,
      preferred_currency: null,
    });
    expect(line).toBe('• New candidate');
  });
});

describe('summarizeJobMatch', () => {
  it('formats a full row as one bullet line', () => {
    const row: AlertJobRow = {
      id: 'j1',
      title: 'Nanny',
      country: 'UAE',
      city: 'Dubai',
      salary_min: 1400,
      salary_max: 1600,
      currency: 'AED',
      live_in_required: true,
      required_skills: ['childcare'],
    };
    expect(summarizeJobMatch(row)).toBe('• Nanny — Dubai, UAE · 1,400–1,600 AED/mo · live-in');
  });

  it('tolerates sparse rows and marks live-out', () => {
    const line = summarizeJobMatch({
      id: 'j2',
      title: null,
      country: 'Saudi Arabia',
      city: null,
      salary_min: null,
      salary_max: 2000,
      currency: 'SAR',
      live_in_required: false,
      required_skills: null,
    });
    expect(line).toBe('• New opening — Saudi Arabia · up to 2,000 SAR/mo · live-out');
  });
});

describe('buildMatchNotification', () => {
  const lines = ['• Meron — Ethiopian · 4 yrs', '• Sara — Ethiopian · 2 yrs', '• Hidden — 3rd line'];

  it('sponsor English includes name, at most 2 lines, and a profile CTA', () => {
    const msg = buildMatchNotification({ side: 'sponsor', language: 'en', contactName: 'Ahmed', lines });
    expect(msg).toContain('Good news, Ahmed!');
    expect(msg).toContain('New candidates matching your search');
    expect(msg).toContain('• Meron');
    expect(msg).toContain('• Sara');
    expect(msg).not.toContain('Hidden');
    expect(msg).toContain('full profiles and photos');
  });

  it('maid English omits the name gracefully and uses the job CTA', () => {
    const msg = buildMatchNotification({ side: 'maid', language: 'en', contactName: null, lines: lines.slice(0, 1) });
    expect(msg).toContain('Good news! 🌸');
    expect(msg).toContain('New jobs matching');
    expect(msg).toContain('how to apply');
  });

  it.each(['ar', 'am'] as const)('%s copy is localized and includes the lines', (lang) => {
    const msg = buildMatchNotification({ side: 'sponsor', language: lang, contactName: null, lines: lines.slice(0, 1) });
    expect(msg).toContain('• Meron');
    expect(msg).not.toMatch(/Good news/);
  });
});

describe('isMetaWindowClosedError', () => {
  it('detects the 131047 re-engagement rejection', () => {
    expect(isMetaWindowClosedError('(#131047) Re-engagement message')).toBe(true);
    expect(isMetaWindowClosedError('Message failed: re-engagement required')).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isMetaWindowClosedError('(#131026) Message undeliverable')).toBe(false);
    expect(isMetaWindowClosedError('network timeout')).toBe(false);
  });
});
