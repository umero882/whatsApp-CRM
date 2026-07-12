/**
 * Two-sided match alerts — pure logic shared by the `save_match_alert`
 * tool (tools/ethiopian-maids.ts) and the engagement cron sweep
 * (/api/ai/engagement/cron).
 *
 * A match alert is a saved search on one side of the marketplace:
 *   sponsor — customer wants a maid; sweep searches maid_profiles_public
 *   maid    — customer wants a job;  sweep searches jobs
 *
 * The sweep only notifies about rows NEWER than the alert watermark
 * (last_notified_at, falling back to the alert's created_at), so the
 * same candidate/job never notifies twice.
 *
 * Everything here is pure and unit-tested; no I/O.
 */

export type MatchSide = 'sponsor' | 'maid';
export type AlertLanguage = 'en' | 'ar' | 'am';

/**
 * Normalized saved-search criteria. Flat union of both sides — the
 * side decides which fields the where-builders read.
 */
export interface MatchCriteria {
  /** Both sides: live-in (true) / live-out (false). */
  live_in?: boolean;
  // — sponsor side (searching maids) —
  languages?: string[];
  skills?: string[];
  min_experience_years?: number;
  max_salary_aed?: number;
  // — maid side (searching jobs) —
  country?: string;
  city?: string;
  /** The maid's own experience; jobs must require <= this. */
  maid_experience_years?: number;
}

function uniqStrings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = String(v).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function clampNumber(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(n, min), max);
}

/**
 * Validate + trim raw tool arguments into a MatchCriteria for the given
 * side. Fields that don't belong to the side (or fail validation) are
 * dropped — an empty object is a legal "notify me about anything new"
 * alert.
 */
export function normalizeAlertCriteria(
  side: MatchSide,
  raw: Record<string, unknown>,
): MatchCriteria {
  const c: MatchCriteria = {};
  if (typeof raw.live_in === 'boolean') c.live_in = raw.live_in;
  if (side === 'sponsor') {
    if (Array.isArray(raw.languages)) {
      const a = uniqStrings(raw.languages);
      if (a.length) c.languages = a;
    }
    if (Array.isArray(raw.skills)) {
      const a = uniqStrings(raw.skills);
      if (a.length) c.skills = a;
    }
    const exp = clampNumber(raw.min_experience_years, 0, 40);
    if (exp !== undefined) c.min_experience_years = exp;
    const sal = clampNumber(raw.max_salary_aed, 1, 100_000);
    if (sal !== undefined) c.max_salary_aed = sal;
  } else {
    if (typeof raw.country === 'string' && raw.country.trim()) {
      c.country = raw.country.trim().slice(0, 80);
    }
    if (typeof raw.city === 'string' && raw.city.trim()) {
      c.city = raw.city.trim().slice(0, 80);
    }
    const exp = clampNumber(raw.maid_experience_years, 0, 40);
    if (exp !== undefined) c.maid_experience_years = exp;
  }
  return c;
}

// ----------------------------------------------------------------
// Hasura where-builders — mirror the semantics of the interactive
// search_maids / list_jobs tools, plus the watermark filter.
// ----------------------------------------------------------------

/** Sponsor alert → maids updated after the watermark. */
export function buildMaidAlertWhere(
  c: MatchCriteria,
  sinceIso: string,
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    availability_status: { _eq: 'available' },
    is_approved: { _eq: true },
    updated_at: { _gt: sinceIso },
  };
  if (typeof c.live_in === 'boolean') {
    where.live_in_preference = { _eq: c.live_in };
  }
  if (typeof c.min_experience_years === 'number') {
    where.experience_years = { _gte: c.min_experience_years };
  }
  if (typeof c.max_salary_aed === 'number') {
    where.preferred_salary_max = { _lte: c.max_salary_aed };
  }
  // Same "match ANY language/skill" OR-of-_contains trick as search_maids.
  const or: unknown[] = [];
  for (const l of c.languages ?? []) or.push({ languages: { _contains: [l] } });
  for (const s of c.skills ?? []) or.push({ skills: { _contains: [s] } });
  if (or.length > 0) where._or = or;
  return where;
}

/** Maid alert → jobs created after the watermark. */
export function buildJobAlertWhere(
  c: MatchCriteria,
  sinceIso: string,
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    status: { _eq: 'active' },
    created_at: { _gt: sinceIso },
  };
  if (typeof c.country === 'string') where.country = { _ilike: `%${c.country}%` };
  if (typeof c.city === 'string') where.city = { _ilike: `%${c.city}%` };
  if (typeof c.live_in === 'boolean') where.live_in_required = { _eq: c.live_in };
  if (typeof c.maid_experience_years === 'number') {
    where.minimum_experience_years = { _lte: c.maid_experience_years };
  }
  return where;
}

export const ALERT_MAIDS_GQL = /* GraphQL */ `
  query AlertMaids($where: maid_profiles_public_bool_exp!, $limit: Int!) {
    maid_profiles_public(where: $where, limit: $limit, order_by: [{ updated_at: desc }]) {
      id
      first_name
      full_name
      nationality
      country
      experience_years
      languages
      skills
      preferred_salary_min
      preferred_salary_max
      preferred_currency
    }
  }
`;

export const ALERT_JOBS_GQL = /* GraphQL */ `
  query AlertJobs($where: jobs_bool_exp!, $limit: Int!) {
    jobs(where: $where, limit: $limit, order_by: [{ created_at: desc }]) {
      id
      title
      country
      city
      salary_min
      salary_max
      currency
      live_in_required
      required_skills
    }
  }
`;

export interface AlertMaidRow {
  id: string;
  first_name: string | null;
  full_name: string | null;
  nationality: string | null;
  country: string | null;
  experience_years: number | null;
  languages: string[] | null;
  skills: string[] | null;
  preferred_salary_min: number | null;
  preferred_salary_max: number | null;
  preferred_currency: string | null;
}

export interface AlertJobRow {
  id: string;
  title: string | null;
  country: string | null;
  city: string | null;
  salary_min: number | null;
  salary_max: number | null;
  currency: string | null;
  live_in_required: boolean | null;
  required_skills: string[] | null;
}

function formatSalaryRange(
  min: number | null,
  max: number | null,
  currency: string | null,
): string {
  const cur = currency || 'AED';
  if (min && max && min !== max) return `${min.toLocaleString()}–${max.toLocaleString()} ${cur}/mo`;
  if (min) return `${min.toLocaleString()} ${cur}/mo`;
  if (max) return `up to ${max.toLocaleString()} ${cur}/mo`;
  return '';
}

/** One bullet line for a newly-available maid. */
export function summarizeMaidMatch(m: AlertMaidRow): string {
  const name = (m.first_name || m.full_name || 'New candidate').trim();
  const origin = m.nationality || m.country || 'Ethiopian';
  const parts = [`${name} — ${origin}`];
  if (typeof m.experience_years === 'number') {
    parts.push(`${m.experience_years} yr${m.experience_years === 1 ? '' : 's'} experience`);
  }
  const skills = (m.skills ?? []).slice(0, 3).join(', ');
  if (skills) parts.push(skills);
  const salary = formatSalaryRange(m.preferred_salary_min, m.preferred_salary_max, m.preferred_currency);
  if (salary) parts.push(salary);
  return `• ${parts.join(' · ')}`;
}

/** One bullet line for a newly-posted job. */
export function summarizeJobMatch(j: AlertJobRow): string {
  const title = (j.title || 'New opening').trim();
  const place = [j.city, j.country].filter(Boolean).join(', ');
  const parts = [place ? `${title} — ${place}` : title];
  const salary = formatSalaryRange(j.salary_min, j.salary_max, j.currency);
  if (salary) parts.push(salary);
  if (j.live_in_required === true) parts.push('live-in');
  else if (j.live_in_required === false) parts.push('live-out');
  return `• ${parts.join(' · ')}`;
}

/**
 * Compose the proactive WhatsApp notification for an alert that found
 * new matches. `lines` come from the summarizers above (max 2 shown).
 */
export function buildMatchNotification(input: {
  side: MatchSide;
  language: AlertLanguage;
  contactName: string | null;
  lines: string[];
}): string {
  const name = input.contactName?.trim();
  const shown = input.lines.slice(0, 2).join('\n');
  if (input.language === 'ar') {
    const greet = name ? `أخبار سارة يا ${name}! 🌸` : 'أخبار سارة! 🌸';
    const intro = input.side === 'sponsor'
      ? 'وصلت مرشحات جديدات تطابق ما تبحث عنه:'
      : 'توفرت وظائف جديدة تناسب ما تبحثين عنه:';
    const cta = input.side === 'sponsor'
      ? 'رد هنا وسأرسل لك الملفات الكاملة مع الصور.'
      : 'ردي هنا وسأرسل لك التفاصيل وكيفية التقديم.';
    return `${greet} ${intro}\n\n${shown}\n\n${cta}`;
  }
  if (input.language === 'am') {
    const greet = name ? `መልካም ዜና ${name}! 🌸` : 'መልካም ዜና! 🌸';
    const intro = input.side === 'sponsor'
      ? 'ከፍለጋዎ ጋር የሚመሳሰሉ አዳዲስ እጩዎች መጥተዋል:'
      : 'ከሚፈልጉት ጋር የሚስማሙ አዳዲስ ስራዎች ተከፍተዋል:';
    const cta = input.side === 'sponsor'
      ? 'እዚህ ይመልሱ — ሙሉ መገለጫና ፎቶ እልክልዎታለሁ።'
      : 'እዚህ ይመልሱ — ዝርዝሩን እና እንዴት እንደሚያመለክቱ እነግርዎታለሁ።';
    return `${greet} ${intro}\n\n${shown}\n\n${cta}`;
  }
  const greet = name ? `Good news, ${name}! 🌸` : 'Good news! 🌸';
  const intro = input.side === 'sponsor'
    ? 'New candidates matching your search just became available:'
    : 'New jobs matching what you\'re looking for just opened:';
  const cta = input.side === 'sponsor'
    ? 'Reply here and I\'ll share their full profiles and photos.'
    : 'Reply here and I\'ll share the details and how to apply.';
  return `${greet} ${intro}\n\n${shown}\n\n${cta}`;
}

/**
 * True when a Meta send failed because the 24h customer-service window
 * is closed (error 131047 "Re-engagement message"). The caller can then
 * fall back to a pre-approved template.
 */
export function isMetaWindowClosedError(message: string): boolean {
  return /131047/.test(message) || /re-?engagement/i.test(message);
}
