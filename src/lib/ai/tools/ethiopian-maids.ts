/**
 * Ethiopian Maids tool set — calls the user's Hasura GraphQL endpoint
 * for live data on candidates, jobs, and pricing.
 *
 * Schema this targets (verified against api.ethiopianmaids.com 2026-05):
 *   maid_profiles               — the candidates themselves
 *   agency_jobs                 — jobs the agency has posted
 *   platform_fee_requirements   — country-keyed agency / govt fees
 *   bookings / booking_requests — bookings (not yet exposed as a tool)
 *
 * Tool failures bubble back to the LLM as structured `{error:"..."}`
 * results so the model can apologize or escalate gracefully.
 */

import { makeHasuraClient, HasuraError } from './hasura';
import { normalizeAlertCriteria, type AlertLanguage, type MatchSide } from '../matching';
import { notifyAdminOfEscalation } from '../escalation-notify';
import {
  INTERACTIVE_LIMITS,
  sendCtaUrlMessage,
  sendImageMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendTextMessage,
} from '@/lib/whatsapp/meta-api';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import type { ToolHandler, ToolContext } from './registry';

function ensureHasura(ctx: ToolContext) {
  if (!ctx.hasuraUrl) {
    throw new Error(
      'Hasura URL is not configured. Set it in Settings → AI Agent before this tool can be used.',
    );
  }
  return makeHasuraClient(ctx.hasuraUrl, ctx.hasuraAdminSecret);
}

// ----------------------------------------------------------------
// search_maids — query maid_profiles_public (PUBLIC view, redacted fields)
// ----------------------------------------------------------------
const SEARCH_MAIDS_GQL = /* GraphQL */ `
  query SearchMaids($where: maid_profiles_public_bool_exp!, $limit: Int!) {
    maid_profiles_public(
      where: $where
      limit: $limit
      order_by: [{ updated_at: desc }]
    ) {
      id
      first_name
      full_name
      country
      nationality
      experience_years
      education_level
      languages
      skills
      special_skills
      live_in_preference
      preferred_salary_min
      preferred_salary_max
      preferred_currency
      profile_photo_url
      availability_status
      available_from
      current_location
      primary_profession
      about_me
    }
  }
`;

/**
 * The GCC markets a sponsor can be in, keyed by ISO code, with the
 * currency candidates are priced in for that market and the spellings a
 * customer (or our own outreach message) uses for it. The public maid view
 * carries no "destination country" column — the maid's preferred countries
 * live in a jsonb the view does not expose — so `preferred_currency` is the
 * one field that says which market a candidate is priced for: a maid at
 * 120–150 KWD/mo is a Kuwait candidate, whatever her current location.
 */
const GCC_MARKETS: Array<{ iso: string; currency: string; name: string; places: string[] }> = [
  { iso: 'AE', currency: 'AED', name: 'UAE', places: ['uae', 'united arab emirates', 'emirates', 'dubai', 'abu dhabi', 'sharjah', 'ajman', 'fujairah', 'ras al khaimah', 'rak', 'umm al quwain', 'al ain', 'al shamkha', 'khalifa city', 'jumeirah', 'deira'] },
  { iso: 'SA', currency: 'SAR', name: 'Saudi Arabia', places: ['saudi', 'saudi arabia', 'ksa', 'riyadh', 'al riyadh', 'jeddah', 'jiddah', 'dammam', 'al ahsa', 'al hasa', 'hofuf', 'al khobar', 'khobar', 'dhahran', 'jubail', 'mecca', 'makkah', 'medina', 'madinah', 'tabuk', 'abha', 'taif', 'qatif', 'buraidah', 'hail', 'najran', 'yanbu'] },
  { iso: 'KW', currency: 'KWD', name: 'Kuwait', places: ['kuwait', 'kuwait city', 'hawalli', 'salmiya', 'farwaniya', 'jahra', 'ahmadi', 'mubarak al kabeer'] },
  { iso: 'QA', currency: 'QAR', name: 'Qatar', places: ['qatar', 'doha', 'al rayyan', 'al wakrah', 'lusail', 'al khor'] },
  { iso: 'BH', currency: 'BHD', name: 'Bahrain', places: ['bahrain', 'manama', 'muharraq', 'riffa', 'isa town', 'hamad town'] },
  { iso: 'OM', currency: 'OMR', name: 'Oman', places: ['oman', 'muscat', 'salalah', 'sohar', 'seeb', 'nizwa', 'sur'] },
];

export interface SponsorMarket {
  iso: string;
  currency: string;
  name: string;
}

/**
 * The market behind whatever the customer said about where they are —
 * an ISO code, a country, an emirate, a city, or a longer phrase such as
 * "Al Shamkha, Abu Dhabi". Whole words only, so "Romania" is not Oman.
 * Null outside the GCC. Pure — exported for tests.
 */
export function resolveSponsorCountry(input: unknown): SponsorMarket | null {
  if (typeof input !== 'string') return null;
  const text = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!text) return null;
  const upper = input.trim().toUpperCase();
  for (const market of GCC_MARKETS) {
    if (upper === market.iso) return { iso: market.iso, currency: market.currency, name: market.name };
  }
  // Longest spelling first so "abu dhabi" beats nothing shorter that might sit inside it.
  const candidates = GCC_MARKETS.flatMap((m) => m.places.map((place) => ({ place, market: m })))
    .sort((a, b) => b.place.length - a.place.length);
  for (const { place, market } of candidates) {
    const re = new RegExp(`(^|\\s)${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    if (re.test(text)) return { iso: market.iso, currency: market.currency, name: market.name };
  }
  return null;
}

export const searchMaids: ToolHandler = {
  name: 'search_maids',
  description:
    'Find available domestic workers (maids) matching the customer requirements. ' +
    'Returns up to 5 candidates with first name, age estimate, nationality, languages, skills, salary preference, and photo URL. ' +
    'ALWAYS pass country — the GCC country or city the sponsor is in (our outreach message names the city; otherwise they told you). ' +
    'Candidates are priced per market: without country a Kuwait-priced maid is shown to a Dubai family. ' +
    'Use this BEFORE recommending any specific maid — never fabricate candidates. ' +
    'Do NOT call this for greetings or chit-chat — only when the customer has expressed interest in hiring AND given at least one criterion (location, duties, or live-in preference).',
  parameters: {
    type: 'object',
    properties: {
      country: {
        type: 'string',
        description:
          "Where the sponsor is: a GCC country, emirate or city in any spelling — 'UAE', 'Dubai', 'Abu Dhabi', 'Riyadh', 'Al Ahsa', 'Kuwait', 'Doha', 'Manama', 'Muscat'. " +
          'Keeps only candidates priced for that market. ALWAYS pass it once known.',
      },
      live_in_preference: {
        type: 'boolean',
        description: 'true for live-in maids, false for live-out. Omit if customer hasn\'t specified.',
      },
      languages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Languages the maid should speak, e.g. ["English","Arabic"]. Omit if not specified.',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required skills, e.g. ["childcare","cooking","cleaning","elderly_care"]. Omit if not specified.',
      },
      min_experience_years: {
        type: 'number',
        description: 'Minimum years of experience.',
      },
      max_salary: {
        type: 'number',
        description: "Maximum monthly salary the customer is willing to pay, in their country's currency (AED for the UAE, SAR for Saudi Arabia, KWD, QAR, BHD, OMR).",
      },
      max_salary_aed: {
        type: 'number',
        description: 'Older name for max_salary — the same number, in the sponsor\'s currency.',
      },
      limit: {
        type: 'number',
        description: 'Max results, 1-10. Default 5.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasura = ensureHasura(ctx);
    const where: Record<string, unknown> = {
      availability_status: { _eq: 'available' },
      is_approved: { _eq: true },
    };
    if (typeof args.live_in_preference === 'boolean') {
      where.live_in_preference = { _eq: args.live_in_preference };
    }
    if (typeof args.min_experience_years === 'number') {
      where.experience_years = { _gte: args.min_experience_years };
    }
    const maxSalary = typeof args.max_salary === 'number' ? args.max_salary
      : typeof args.max_salary_aed === 'number' ? args.max_salary_aed : null;
    if (maxSalary !== null) {
      where.preferred_salary_max = { _lte: maxSalary };
    }
    // Each group below is its own OR, and the groups AND together — the
    // market clause must never widen the languages/skills match.
    const groups: unknown[] = [];
    // The sponsor's market: candidates priced in its currency, plus those
    // not priced yet (no currency on file) so a new profile is not hidden.
    const market = resolveSponsorCountry(args.country);
    if (market) {
      groups.push({ _or: [{ preferred_currency: { _eq: market.currency } }, { preferred_currency: { _is_null: true } }] });
    }
    // languages/skills are text[] (LIST in GraphQL). For "match ANY",
    // Postgres text[] supports overlap (&&) but Hasura's standard
    // operators don't expose it directly. We OR multiple _contains
    // checks (each _contains is "column @> [item]" — subset semantics
    // that returns true when the row's array contains the item).
    const any: unknown[] = [];
    if (Array.isArray(args.languages) && args.languages.length > 0) {
      any.push(...args.languages.map((l) => ({ languages: { _contains: [String(l)] } })));
    }
    if (Array.isArray(args.skills) && args.skills.length > 0) {
      any.push(...args.skills.map((s) => ({ skills: { _contains: [String(s)] } })));
    }
    if (any.length) groups.push({ _or: any });
    if (groups.length) where._and = groups;
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    try {
      const data = await hasura.query<{ maid_profiles_public: unknown[] }>(
        SEARCH_MAIDS_GQL,
        { where, limit },
      );
      const maids = data.maid_profiles_public ?? [];
      const marketNote = market
        ? ` Candidates shown are priced for ${market.name} (${market.currency}).`
        : typeof args.country === 'string' && args.country.trim()
          ? ` "${args.country}" is not a GCC place we serve — the search ran without a market filter; confirm the country with the customer (we place in the UAE, Saudi Arabia, Kuwait, Qatar, Bahrain and Oman).`
          : ' No country was given, so candidates from every market are mixed in — pass country next time.';
      return {
        count: maids.length,
        market,
        maids,
        note:
          (maids.length === 0
            ? 'No matching candidates with these criteria. Call reply_with_choices with a short apology-question and options like ["Alert me when found","Widen the search"]. If they tap the alert option, call save_match_alert with side="sponsor" and these criteria so we message them the moment a matching candidate becomes available.'
            : 'Recommend at most 2-3 of these candidates. Mention first name, nationality/country, experience years, key skills, and the salary range. If a photo_url exists, mention "I can share a photo if you\'d like".')
          + marketNote,
      };
    } catch (e) {
      if (e instanceof HasuraError) {
        return { error: e.message, hint: 'Hasura query failed — consider escalating to a human.' };
      }
      throw e;
    }
  },
};

// ----------------------------------------------------------------
// get_maid_profile — full details on one
// ----------------------------------------------------------------
const GET_MAID_GQL = /* GraphQL */ `
  query GetMaid($id: String!) {
    maid_profiles_public(where: { id: { _eq: $id } }, limit: 1) {
      id
      first_name
      full_name
      country
      nationality
      experience_years
      education_level
      languages
      skills
      special_skills
      live_in_preference
      preferred_salary_min
      preferred_salary_max
      preferred_currency
      profile_photo_url
      availability_status
      available_from
      current_location
      primary_profession
      about_me
      additional_notes
      contract_duration_preference
      work_preferences
    }
  }
`;

export const getMaidProfile: ToolHandler = {
  name: 'get_maid_profile',
  description:
    'Full details of a single maid by id. Use after search_maids when the customer asks for more on a specific candidate.',
  parameters: {
    type: 'object',
    properties: {
      maid_id: { type: 'string', description: 'String id of the maid (from search_maids results).' },
    },
    required: ['maid_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasura = ensureHasura(ctx);
    const id = String(args.maid_id);
    try {
      const data = await hasura.query<{ maid_profiles_public: unknown[] }>(GET_MAID_GQL, { id });
      const row = data.maid_profiles_public?.[0];
      if (!row) return { error: `No maid with id ${id}.` };
      return { maid: row };
    } catch (e) {
      if (e instanceof HasuraError) return { error: e.message };
      throw e;
    }
  },
};

// ----------------------------------------------------------------
// list_jobs — query the `jobs` table (sponsor-posted openings that
// maids apply to). The agency_jobs table is for agency-managed
// internal listings; the `jobs` table is the actual marketplace.
// ----------------------------------------------------------------
const LIST_JOBS_GQL = /* GraphQL */ `
  query ListJobs($where: jobs_bool_exp!, $limit: Int!) {
    jobs(
      where: $where
      limit: $limit
      order_by: [{ created_at: desc }]
    ) {
      id
      title
      country
      city
      location
      job_type
      contract_duration
      contract_duration_months
      salary_min
      salary_max
      currency
      salary_period
      live_in_required
      required_skills
      languages_required
      minimum_experience_years
      preferred_nationality
      benefits
      description
      start_date
      status
      urgent
      days_off_per_week
      working_hours_per_day
    }
  }
`;

export const listJobs: ToolHandler = {
  name: 'list_jobs',
  description:
    'List ACTIVE maid-placement jobs that sponsors have posted (the marketplace of openings). ' +
    'Use when a customer who is a maid / job-seeker has told you their destination country or city. ' +
    'Returns up to 5 jobs with title, location, salary range, live-in requirement, required skills, and experience minimum.',
  parameters: {
    type: 'object',
    properties: {
      country: {
        type: 'string',
        description: 'Destination country filter, e.g. "UAE", "Saudi Arabia". Optional.',
      },
      city: {
        type: 'string',
        description: 'Destination city filter, e.g. "Dubai", "Riyadh". Optional.',
      },
      live_in_required: {
        type: 'boolean',
        description: 'Only live-in jobs (true) / only live-out (false) / both (omit).',
      },
      min_experience_years: {
        type: 'number',
        description: 'Only jobs whose minimum_experience_years <= this. Use the maid\'s experience to filter.',
      },
      limit: { type: 'number', description: 'Max results 1-10. Default 5.' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasura = ensureHasura(ctx);
    const where: Record<string, unknown> = {
      status: { _eq: 'active' },
    };
    if (typeof args.country === 'string' && args.country.trim()) {
      where.country = { _ilike: `%${args.country.trim()}%` };
    }
    if (typeof args.city === 'string' && args.city.trim()) {
      where.city = { _ilike: `%${args.city.trim()}%` };
    }
    if (typeof args.live_in_required === 'boolean') {
      where.live_in_required = { _eq: args.live_in_required };
    }
    if (typeof args.min_experience_years === 'number') {
      where.minimum_experience_years = { _lte: args.min_experience_years };
    }
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    try {
      const data = await hasura.query<{ jobs: unknown[] }>(LIST_JOBS_GQL, { where, limit });
      const jobs = data.jobs ?? [];
      return {
        count: jobs.length,
        jobs,
        note: jobs.length === 0
          ? 'No active jobs match these criteria. Call reply_with_choices with a short apology-question and options like ["Alert me about jobs","Search other cities"]. If she taps the alert option, call save_match_alert with side="maid" and these criteria so we message her the moment a matching job opens.'
          : 'Present 1-3 of these jobs to the customer with: title, city/country, salary range with currency, live-in or live-out, key required skills. Ask which one she\'d like to apply for or want more detail on.',
      };
    } catch (e) {
      if (e instanceof HasuraError) return { error: e.message };
      throw e;
    }
  },
};

// ----------------------------------------------------------------
// get_pricing — platform_fee_requirements (country-keyed)
// ----------------------------------------------------------------
const GET_PRICING_GQL = /* GraphQL */ `
  query GetPricing($where: platform_fee_requirements_bool_exp!) {
    platform_fee_requirements(where: $where, order_by: [{ amount: asc }]) {
      country_code
      country_name
      amount
      currency
    }
  }
`;

export const getPricing: ToolHandler = {
  name: 'get_pricing',
  description:
    'Return the platform / placement fee for a given country. ALWAYS call before quoting any fee — never invent prices. Country can be a 2-letter code (e.g. "AE") or a name ("UAE").',
  parameters: {
    type: 'object',
    properties: {
      country: {
        type: 'string',
        description: '2-letter ISO code or country name. E.g. "AE", "UAE", "SA", "Saudi Arabia".',
      },
    },
    required: ['country'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasura = ensureHasura(ctx);
    const q = String(args.country ?? '').trim();
    if (!q) return { error: 'country is required' };
    const where: Record<string, unknown> = {
      is_active: { _eq: true },
      _or: [
        { country_code: { _ilike: q } },
        { country_name: { _ilike: `%${q}%` } },
      ],
    };
    try {
      const data = await hasura.query<{
        platform_fee_requirements: Array<{
          country_code: string;
          country_name: string;
          amount: number;
          currency: string;
        }>;
      }>(GET_PRICING_GQL, { where });
      const rows = data.platform_fee_requirements ?? [];
      if (rows.length === 0) {
        return {
          error: `No pricing on file for "${q}". Escalate to a human for a custom quote.`,
        };
      }
      return { pricing: rows };
    } catch (e) {
      if (e instanceof HasuraError) return { error: e.message };
      throw e;
    }
  },
};

// ----------------------------------------------------------------
// escalate_to_human (Supabase-backed + WhatsApp forward to admin)
// ----------------------------------------------------------------

/**
 * Compose the WhatsApp message the human admin receives when the AI
 * escalates. Pure — exported for tests.
 */
export function buildEscalationForward(input: {
  customerName: string | null;
  customerPhone: string;
  reason: string;
  issueSummary: string | null;
  urgent: boolean;
}): string {
  const digits = input.customerPhone.replace(/\D/g, '');
  const lines = [
    input.urgent ? '🔴 URGENT — human needed' : '🟠 Human needed',
    `Customer: ${input.customerName?.trim() || 'Unknown'} (+${digits})`,
    `Reason: ${input.reason}`,
  ];
  if (input.issueSummary?.trim()) lines.push(`Issue: ${input.issueSummary.trim()}`);
  lines.push(`Reply directly: https://wa.me/${digits}`);
  return lines.join('\n');
}

export const escalateToHuman: ToolHandler = {
  name: 'escalate_to_human',
  description:
    'Hand off to a human agent. Use when the customer is upset, asks for refunds, contract signing, raises safety concerns, or asks something the other tools genuinely cannot answer. ' +
    'Forwards the issue AND the customer\'s WhatsApp number to the human admin, pauses the AI for 24h on this conversation, and tags it for human pickup. ' +
    'Pass issue_summary with the concrete details the admin needs (what the customer wants, names/dates/amounts they mentioned). ' +
    'After calling this, send ONE short reply telling the customer their issue has been forwarded and a human will contact them.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'One short sentence on why a human is needed.' },
      issue_summary: {
        type: 'string',
        description: 'Concrete details for the admin: what the customer needs, plus any names, dates, amounts, or context they gave. 1-3 sentences.',
      },
      urgent: { type: 'boolean', description: 'True for safety/abuse/trafficking concerns or active anger.' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const reason = String(args.reason ?? 'human_requested').slice(0, 200);
    const issueSummary = typeof args.issue_summary === 'string' ? args.issue_summary.slice(0, 600) : null;
    const urgent = Boolean(args.urgent);

    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await ctx.supabase
      .from('conversations')
      .update({ ai_paused_until: until })
      .eq('id', ctx.conversationId);

    const tagName = urgent ? 'urgent_human' : 'needs_human';
    try {
      const { data: existingTag } = await ctx.supabase
        .from('tags')
        .select('id')
        .eq('user_id', ctx.userId)
        .eq('name', tagName)
        .maybeSingle();
      let tagId = existingTag?.id as string | undefined;
      if (!tagId) {
        const { data: newTag } = await ctx.supabase
          .from('tags')
          .insert({ user_id: ctx.userId, name: tagName, color: urgent ? '#dc2626' : '#f59e0b' })
          .select('id')
          .single();
        tagId = newTag?.id;
      }
      if (tagId) {
        const { data: conv } = await ctx.supabase
          .from('conversations')
          .select('contact_id')
          .eq('id', ctx.conversationId)
          .maybeSingle();
        if (conv?.contact_id) {
          await ctx.supabase
            .from('contact_tags')
            .upsert(
              { contact_id: conv.contact_id, tag_id: tagId },
              { onConflict: 'contact_id,tag_id' },
            );
        }
      }
    } catch (e) {
      console.warn('[ai/escalate] tag failed (non-fatal):', e instanceof Error ? e.message : e);
    }

    // Forward the issue + customer number to the human admin's WhatsApp.
    // Uses the business number's own send credentials. Non-fatal: pause +
    // tag above already happened, so a failed forward degrades to the old
    // behavior instead of blocking the escalation.
    let adminNotified = false;
    if (ctx.escalationPhone && ctx.whatsapp) {
      const forward = buildEscalationForward({
        customerName: ctx.contactName,
        customerPhone: ctx.contactPhone,
        reason,
        issueSummary,
        urgent,
      });
      try {
        await sendTextMessage({
          phoneNumberId: ctx.whatsapp.phoneNumberId,
          accessToken: ctx.whatsapp.accessToken,
          to: sanitizePhoneForMeta(ctx.escalationPhone),
          text: forward,
        });
        adminNotified = true;
      } catch (e) {
        // Most common cause: Meta's 24h customer-service window — the
        // admin number hasn't messaged the business number recently, so
        // free-form sends are rejected until they do.
        console.error('[ai/escalate] admin forward failed:', e instanceof Error ? e.message : e);
      }
    } else {
      console.warn('[ai/escalate] admin forward skipped: escalationPhone or whatsapp creds missing');
    }

    // Push + in-app notification to the admin app via the maids-app's existing
    // Hasura notifications → sendPush pipeline. Non-fatal and independent of
    // the WhatsApp forward above, so the admin still gets alerted in-app even
    // when Meta's 24h window blocks the WhatsApp message.
    let appNotified = false;
    if (ctx.hasuraUrl) {
      try {
        const hasura = makeHasuraClient(ctx.hasuraUrl, ctx.hasuraAdminSecret);
        const r = await notifyAdminOfEscalation(hasura, {
          escalationPhone: ctx.escalationPhone,
          conversationId: ctx.conversationId,
          customerName: ctx.contactName,
          customerPhone: ctx.contactPhone,
          reason,
          issueSummary,
          urgent,
          adminUidOverride: process.env.ESCALATION_ADMIN_UID ?? null,
        });
        appNotified = r.notified;
      } catch (e) {
        console.warn('[ai/escalate] app push failed (non-fatal):', e instanceof Error ? e.message : e);
      }
    }

    return {
      ok: true,
      ai_paused_until: until,
      reason,
      urgent,
      admin_notified: adminNotified,
      app_notified: appNotified,
      note: adminNotified
        ? 'Issue forwarded to the human admin on WhatsApp with the customer\'s number. Send ONE final reply telling the customer their issue has been passed to our team and someone will contact them on this number shortly.'
        : 'Conversation is tagged for human pickup (direct admin forward could not be delivered). Send ONE final reply telling the customer our team will review and contact them on this number — do NOT promise an immediate response.',
    };
  },
};

// ----------------------------------------------------------------
// send_app_download_card — official-looking interactive card that
// directs the customer to the Ethiopian Maids app. Customers distrust
// raw pasted URLs (scam fear), so this renders the official store
// badge (Google Play or the App Store, chosen by platform) as header
// image + a tappable "Open Google Play" / "Open App Store" button
// instead of a bare link.
// ----------------------------------------------------------------

export const APP_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.ethiopianmaids.app';

export const APP_APP_STORE_URL =
  'https://apps.apple.com/us/app/ethiopian-maids/id6762796104';

/** Google's own hosted "Get it on Google Play" badge (official artwork). */
const PLAY_BADGE_IMAGE_URL =
  'https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png';

/**
 * Apple's official badge, rasterized to PNG and served from our domain.
 * Apple only publishes it as SVG, which Meta's image header rejects.
 */
const APP_STORE_BADGE_IMAGE_URL = 'https://ethiopianmaids.com/badges/app-store.png';

export type AppCardLanguage = 'en' | 'ar' | 'am';
export type AppCardPlatform = 'android' | 'ios';

export interface AppDownloadCard {
  bodyText: string;
  buttonText: string;
  footerText: string;
  headerImageUrl: string;
  url: string;
}

/**
 * Localized copy for the app-download card. Pure — exported for tests.
 * Button text must stay ≤20 chars (Meta cta_url display_text limit);
 * footer ≤60. Each footer names the OTHER store so a single card still
 * tells both audiences the app exists.
 */
export function buildAppDownloadCard(
  language: AppCardLanguage,
  platform: AppCardPlatform = 'android',
): AppDownloadCard {
  const copy: Record<
    AppCardLanguage,
    Record<AppCardPlatform, { body: string; button: string; footer: string }>
  > = {
    en: {
      android: {
        body:
          'This is the official Ethiopian Maids app on Google Play. ' +
          'Download it to register, browse candidates, and apply for jobs — all in one safe place.',
        button: 'Open Google Play',
        footer: 'Also available on the App Store',
      },
      ios: {
        body:
          'This is the official Ethiopian Maids app on the App Store. ' +
          'Download it to register, browse candidates, and apply for jobs — all in one safe place.',
        button: 'Open App Store',
        footer: 'Also available on Google Play',
      },
    },
    ar: {
      android: {
        body:
          'هذا هو تطبيق Ethiopian Maids الرسمي على متجر Google Play. ' +
          'حمّله للتسجيل وتصفح المرشحات والتقديم على الوظائف — كل ذلك في مكان واحد آمن.',
        button: 'افتح Google Play',
        footer: 'متوفر أيضاً على App Store',
      },
      ios: {
        body:
          'هذا هو تطبيق Ethiopian Maids الرسمي على App Store. ' +
          'حمّله للتسجيل وتصفح المرشحات والتقديم على الوظائف — كل ذلك في مكان واحد آمن.',
        button: 'افتح App Store',
        footer: 'متوفر أيضاً على Google Play',
      },
    },
    am: {
      android: {
        body:
          'ይህ በGoogle Play ላይ ያለው ኦፊሴላዊ የEthiopian Maids መተግበሪያ ነው። ' +
          'ለመመዝገብ፣ እጩዎችን ለማየት እና ለስራ ለማመልከት ያውርዱት።',
        button: 'Google Play ክፈት',
        footer: 'በApp Store ላይም ይገኛል',
      },
      ios: {
        body:
          'ይህ በApp Store ላይ ያለው ኦፊሴላዊ የEthiopian Maids መተግበሪያ ነው። ' +
          'ለመመዝገብ፣ እጩዎችን ለማየት እና ለስራ ለማመልከት ያውርዱት።',
        button: 'App Store ክፈት',
        footer: 'በGoogle Play ላይም ይገኛል',
      },
    },
  };
  const byPlatform = copy[language] ?? copy.en;
  const c = byPlatform[platform] ?? byPlatform.android;
  const isIos = platform === 'ios';
  return {
    bodyText: c.body,
    buttonText: c.button,
    footerText: c.footer,
    headerImageUrl: isIos ? APP_STORE_BADGE_IMAGE_URL : PLAY_BADGE_IMAGE_URL,
    url: isIos ? APP_APP_STORE_URL : APP_PLAY_STORE_URL,
  };
}

type CardDelivery = 'card' | 'card_no_image' | 'text_fallback';

/**
 * Send ONE store's card with graceful degradation: cta_url with the badge
 * image, then without it (Meta occasionally can't fetch the image), then a
 * plain-text link as a last resort. Throws only if all three fail, so the
 * caller can decide whether the other card still made it through.
 */
async function sendAppCard(
  whatsapp: NonNullable<ToolContext['whatsapp']>,
  to: string,
  card: AppDownloadCard,
): Promise<{ messageId: string; deliveredAs: CardDelivery }> {
  const base = {
    phoneNumberId: whatsapp.phoneNumberId,
    accessToken: whatsapp.accessToken,
    to,
    bodyText: card.bodyText,
    buttonText: card.buttonText,
    url: card.url,
    footerText: card.footerText,
  };
  try {
    const r = await sendCtaUrlMessage({ ...base, headerImageUrl: card.headerImageUrl });
    return { messageId: r.messageId, deliveredAs: 'card' };
  } catch (e) {
    console.warn('[send_app_download_card] cta_url with image failed, retrying without:',
      e instanceof Error ? e.message : e);
    try {
      const r = await sendCtaUrlMessage(base);
      return { messageId: r.messageId, deliveredAs: 'card_no_image' };
    } catch (e2) {
      console.warn('[send_app_download_card] cta_url failed, falling back to text:',
        e2 instanceof Error ? e2.message : e2);
      const r = await sendTextMessage({
        phoneNumberId: whatsapp.phoneNumberId,
        accessToken: whatsapp.accessToken,
        to,
        text: `${card.bodyText}\n\n${card.url}\n\n${card.footerText}`,
      });
      return { messageId: r.messageId, deliveredAs: 'text_fallback' };
    }
  }
}

/**
 * Send the store card(s), persist the one inbox row and bump the
 * conversation. Null when every send failed. Shared by the tool and by
 * send_maid_cards, which follows the candidates with the app card.
 */
async function deliverAppDownloadCards(
  ctx: ToolContext,
  language: AppCardLanguage,
  platforms: AppCardPlatform[],
): Promise<Array<{ platform: AppCardPlatform; messageId: string; deliveredAs: CardDelivery }> | null> {
  if (!ctx.whatsapp) return null;
  const to = sanitizePhoneForMeta(ctx.contactPhone);
  const sent: Array<{ platform: AppCardPlatform; messageId: string; deliveredAs: CardDelivery }> = [];
  for (const p of platforms) {
    try {
      const r = await sendAppCard(ctx.whatsapp, to, buildAppDownloadCard(language, p));
      sent.push({ platform: p, ...r });
    } catch (e) {
      console.warn(`[send_app_download_card] ${p} card could not be delivered:`,
        e instanceof Error ? e.message : e);
    }
  }
  if (sent.length === 0) return null;

  // One summary row + conversation bump; message_id is the last card sent.
  await ctx.supabase.from('messages').insert({
    conversation_id: ctx.conversationId,
    sender_type: 'agent',
    agent_kind: 'ai',
    content_type: 'text',
    content_text: '[Official app download card]',
    message_id: sent[sent.length - 1].messageId,
    status: 'sent',
  });
  await ctx.supabase
    .from('conversations')
    .update({
      last_message_text: '[App download card]',
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', ctx.conversationId);
  return sent;
}

export const sendAppDownloadCard: ToolHandler = {
  name: 'send_app_download_card',
  description:
    'Send the OFFICIAL Ethiopian Maids app download card(s): store badge image + a tappable button. ' +
    'ALWAYS use this when directing a customer to download the app or register — NEVER paste a store URL as text (customers fear scam links). ' +
    'If you do not know the phone type, omit platform and BOTH store cards are sent so the customer picks. ' +
    'After sending, your text reply is ONE short sentence pointing at the card(s) — do not repeat any link.',
  parameters: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        enum: ['en', 'ar', 'am'],
        description: 'Card language matching the conversation: en (English), ar (Arabic), am (Amharic). Default en.',
      },
      platform: {
        type: 'string',
        enum: ['android', 'ios'],
        description:
          "The customer's phone type — ONLY pass this if they have already told you. "
          + "Pass 'ios' if they mentioned iPhone, iOS, or the App Store; 'android' if they mentioned "
          + 'Android, Samsung, or Google Play. '
          + 'If they have NOT told you, OMIT this parameter — do NOT guess and do NOT ask. '
          + 'Omitting it sends BOTH store cards (Google Play and App Store) so the customer taps '
          + 'whichever matches their phone. That is always safe.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!ctx.whatsapp) {
      return { error: 'WhatsApp send credentials are not available in this run. Cannot send the card.' };
    }
    const language = (['en', 'ar', 'am'].includes(String(args.language)) ? String(args.language) : 'en') as AppCardLanguage;
    // Only send a single store's card when the customer has actually named
    // their phone. Otherwise send BOTH cards and let them tap the one that
    // matches — never guess a store on their behalf.
    const explicit = (['android', 'ios'].includes(String(args.platform))
      ? String(args.platform)
      : null) as AppCardPlatform | null;
    const platforms: AppCardPlatform[] = explicit ? [explicit] : ['android', 'ios'];

    const sent = await deliverAppDownloadCards(ctx, language, platforms);
    if (!sent) {
      return { error: 'Could not deliver the app download card(s) — every send attempt failed.' };
    }

    const both = sent.length > 1;
    const storeName = sent[0].platform === 'ios' ? 'App Store' : 'Google Play';
    return {
      ok: true,
      sent_cards: sent.map((s) => s.platform),
      language,
      note: both
        ? "Both official app cards (Google Play and App Store) are now in the customer's chat. Reply with ONE short sentence telling them to tap Google Play if they use Android, or App Store if they use iPhone. Do NOT paste any link."
        : `The official ${storeName} card is now in the customer's chat. Reply with ONE short sentence pointing at it (e.g. "Tap the button above to get our official app 🌸"). Do NOT paste any link.`,
    };
  },
};

// ----------------------------------------------------------------
// send_maid_cards — render candidates as image+caption messages on
// WhatsApp. Lets the conversation feel like a card deck instead of
// a wall of text. Call this AFTER search_maids when you want to
// show 1-3 candidates to the customer.
// ----------------------------------------------------------------
const CARDS_FETCH_GQL = /* GraphQL */ `
  query MaidsForCards($ids: [String!]!) {
    maid_profiles_public(where: { id: { _in: $ids } }) {
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
      profile_photo_url
      available_from
      live_in_preference
    }
  }
`;

interface MaidCardRow {
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
  profile_photo_url: string | null;
  available_from: string | null;
  live_in_preference: boolean | null;
}

/** Exported for tests. */
export function buildMaidCaption(m: MaidCardRow): string {
  const name = (m.first_name || m.full_name || 'Candidate').trim();
  // The marketplace serves several nationalities — never assume one.
  const origin = m.nationality || m.country || null;
  const expr = typeof m.experience_years === 'number' ? `${m.experience_years} yr${m.experience_years === 1 ? '' : 's'} experience` : 'experience available';
  const skills = (m.skills ?? []).slice(0, 4).join(', ');
  const langs = (m.languages ?? []).join(', ');
  const sMin = m.preferred_salary_min;
  const sMax = m.preferred_salary_max;
  const cur = m.preferred_currency || 'AED';
  let salary = '';
  if (sMin && sMax && sMin !== sMax) salary = `${sMin.toLocaleString()}–${sMax.toLocaleString()} ${cur}/mo`;
  else if (sMin) salary = `${sMin.toLocaleString()} ${cur}/mo`;
  else if (sMax) salary = `up to ${sMax.toLocaleString()} ${cur}/mo`;
  const liveIn = m.live_in_preference === true ? 'Live-in' : m.live_in_preference === false ? 'Live-out' : null;
  // A start date already behind us means she is available now — a family
  // reads "Available from 2026-08-19" in September as a stale profile.
  const from = (m.available_from || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const avail = from && from > today ? `Available from ${from}` : 'Available now';

  const lines: string[] = [origin ? `*${name}* — ${origin}` : `*${name}*`, `🧰 ${expr}`];
  if (skills) lines.push(`✅ ${skills}`);
  if (langs) lines.push(`🗣️ ${langs}`);
  if (salary) lines.push(`💰 ${salary}${liveIn ? ' · ' + liveIn : ''}`);
  lines.push(`📅 ${avail}`);
  return lines.join('\n');
}

/**
 * Where a card's Contact button goes: the maid's own page in the web app
 * (`/maid/:id`, verified in the site bundle 2026-09-20). The mobile app has
 * the same screen (app/maid/[id].tsx) and shares this very link, so once
 * its universal-link filter covers /maid/* the tap opens the installed app
 * on her profile; until then it is the web app, where the family registers,
 * picks a package and starts the video interview.
 */
export function maidProfileUrl(maidId: string): string {
  return `https://ethiopianmaids.com/maid/${encodeURIComponent(maidId)}`;
}

/** Meta caps a cta_url button label at 20 characters. */
export function buildMaidContactButton(firstName: string): string {
  const label = `Contact ${firstName.trim()}`;
  return firstName.trim() && label.length <= 20 ? label : 'Contact her';
}

/** The grey line under every candidate card (Meta: ≤ 60 characters). */
export const CONTACT_CARD_FOOTER = 'Register in our app, pick a package, video-call her there';

type MaidCardDelivery = 'card' | 'card_no_image' | 'image' | 'text';

/**
 * One candidate as a CTA card: her photo as the header, the caption as the
 * body, one button that opens her profile. Degrades the way the app card
 * does — without the header when Meta cannot fetch the photo, then the
 * plain photo + caption (the link written into the caption), then text.
 */
async function sendMaidCard(
  whatsapp: NonNullable<ToolContext['whatsapp']>,
  to: string,
  m: MaidCardRow,
  caption: string,
): Promise<{ messageId: string; deliveredAs: MaidCardDelivery }> {
  const name = (m.first_name || m.full_name || '').trim().split(/\s+/)[0] ?? '';
  const url = maidProfileUrl(m.id);
  const base = {
    phoneNumberId: whatsapp.phoneNumberId,
    accessToken: whatsapp.accessToken,
    to,
    bodyText: caption,
    buttonText: buildMaidContactButton(name),
    url,
    footerText: CONTACT_CARD_FOOTER,
  };
  if (m.profile_photo_url) {
    try {
      const r = await sendCtaUrlMessage({ ...base, headerImageUrl: m.profile_photo_url });
      return { messageId: r.messageId, deliveredAs: 'card' };
    } catch (e) {
      console.warn('[send_maid_cards] cta_url with photo failed, retrying without:', e instanceof Error ? e.message : e);
    }
  }
  try {
    const r = await sendCtaUrlMessage(base);
    return { messageId: r.messageId, deliveredAs: 'card_no_image' };
  } catch (e) {
    console.warn('[send_maid_cards] cta_url failed, falling back:', e instanceof Error ? e.message : e);
  }
  const withLink = `${caption}\n👉 ${base.buttonText}: ${url}`;
  if (m.profile_photo_url) {
    const r = await sendImageMessage({
      phoneNumberId: whatsapp.phoneNumberId,
      accessToken: whatsapp.accessToken,
      to,
      imageUrl: m.profile_photo_url,
      caption: withLink,
    });
    return { messageId: r.messageId, deliveredAs: 'image' };
  }
  const r = await sendTextMessage({
    phoneNumberId: whatsapp.phoneNumberId,
    accessToken: whatsapp.accessToken,
    to,
    text: withLink,
  });
  return { messageId: r.messageId, deliveredAs: 'text' };
}

/** Has the official app card been delivered in this conversation before? */
async function appCardAlreadySent(ctx: ToolContext): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', ctx.conversationId)
    .eq('sender_type', 'agent')
    .ilike('content_text', '%app download card%')
    .limit(1);
  if (error) {
    console.warn('[send_maid_cards] could not check for an earlier app card:', error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

export const sendMaidCards: ToolHandler = {
  name: 'send_maid_cards',
  description:
    'Render 1–3 maid candidates as WhatsApp cards, one per candidate: her photo, the details, and a Contact button that opens her profile in the Ethiopian Maids app — contact and the video interview happen there, for a registered sponsor on a package, never in this chat. ' +
    'The official app download card follows the candidates (once per conversation). ' +
    'ALWAYS call this when presenting candidates to the customer — do NOT also list them in plain text. ' +
    'Each card shows the maid\'s photo, name, nationality, experience, top skills, languages, salary range, live-in preference, and availability. ' +
    'After this tool succeeds, your final text reply is ONE short sentence — "Tap Contact on the one you like; register in our app, choose a package, and the video interview happens there." — DO NOT repeat the candidate details in your text and do NOT offer to book anything.',
  parameters: {
    type: 'object',
    properties: {
      maid_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of maids to render (from a prior search_maids result). 1 to 3 ids max.',
      },
    },
    required: ['maid_ids'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const ids = Array.isArray(args.maid_ids) ? args.maid_ids.map(String).slice(0, 3) : [];
    if (ids.length === 0) {
      return { error: 'maid_ids must be a non-empty array of 1-3 ids from a recent search_maids result.' };
    }
    if (!ctx.whatsapp) {
      return { error: 'WhatsApp send credentials are not available in this run. Cannot send cards.' };
    }

    const hasura = ensureHasura(ctx);
    let rows: MaidCardRow[] = [];
    try {
      const data = await hasura.query<{ maid_profiles_public: MaidCardRow[] }>(CARDS_FETCH_GQL, { ids });
      rows = data.maid_profiles_public ?? [];
    } catch (e) {
      if (e instanceof HasuraError) return { error: e.message };
      throw e;
    }
    if (rows.length === 0) {
      return { error: `No maids found for ids ${ids.join(', ')}. Re-run search_maids.` };
    }

    // Preserve the agent's intended order rather than DB order.
    const ordered = ids
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is MaidCardRow => Boolean(r));

    const to = sanitizePhoneForMeta(ctx.contactPhone);
    const sent: Array<{ maid_id: string; ok: boolean; delivered_as?: MaidCardDelivery; reason?: string }> = [];

    for (const m of ordered) {
      const caption = buildMaidCaption(m);
      try {
        const r = await sendMaidCard(ctx.whatsapp, to, m, caption);
        const name = (m.first_name || m.full_name || '').trim().split(/\s+/)[0] ?? '';
        // The inbox row: the photo where there is one, the caption, and
        // where the button goes — a person reading the thread sees the same
        // link the customer can tap.
        await ctx.supabase.from('messages').insert({
          conversation_id: ctx.conversationId,
          sender_type: 'agent',
          agent_kind: 'ai',
          content_type: m.profile_photo_url ? 'image' : 'text',
          content_text: `${caption}\n👉 ${buildMaidContactButton(name)} → ${maidProfileUrl(m.id)}`,
          media_url: m.profile_photo_url || null,
          message_id: r.messageId,
          status: 'sent',
        });
        sent.push({ maid_id: m.id, ok: true, delivered_as: r.deliveredAs });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[send_maid_cards] send failed for', m.id, msg);
        sent.push({ maid_id: m.id, ok: false, reason: msg });
      }
    }

    const delivered = sent.filter((s) => s.ok).length;

    // Bump the conversation timestamp so the inbox sorts correctly.
    if (delivered) {
      await ctx.supabase
        .from('conversations')
        .update({
          last_message_text: `[${delivered} candidate card(s)]`,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', ctx.conversationId);
    }

    // The app download card follows the candidates, once: the Contact
    // button leads into the app, so the family has the store card at hand.
    let appCard: 'sent' | 'already_sent' | 'failed' | 'skipped' = 'skipped';
    if (delivered) {
      if (await appCardAlreadySent(ctx)) {
        appCard = 'already_sent';
      } else {
        const r = await deliverAppDownloadCards(ctx, ctx.cardLanguage ?? 'en', ['android', 'ios']);
        appCard = r ? 'sent' : 'failed';
      }
    }

    return {
      sent,
      success_count: delivered,
      app_card: appCard,
      note:
        'Cards are now in the customer\'s WhatsApp, each with a Contact button that opens her profile in the app' +
        (appCard === 'sent' ? ', and the official app download cards followed' : '') +
        '. Your follow-up TEXT reply is ONE short sentence: tap Contact on the one they like — they register in our app, ' +
        'choose a package, and the video interview happens there. ' +
        'Do NOT re-list the candidates in text, do NOT paste a link, and do NOT offer to book or schedule anything.',
    };
  },
};

// ----------------------------------------------------------------
// book_interview — schedule a video interview between the sponsor
// (the WhatsApp customer) and a specific maid. Inserts into bookings,
// generates a Jitsi video room URL, sends the link to the sponsor
// via WhatsApp. Maid-side notification is V2 (Meta requires an
// approved template for first-touch outside the 24h window).
// ----------------------------------------------------------------
const RESOLVE_MAID_GQL = /* GraphQL */ `
  query ResolveMaid($where: maid_profiles_public_bool_exp!) {
    maid_profiles_public(where: $where, limit: 5) {
      id
      first_name
      full_name
      nationality
      country
      availability_status
    }
  }
`;

const FETCH_MAID_PHONE_GQL = /* GraphQL */ `
  query MaidPhone($id: String!) {
    maid_profiles_by_pk(id: $id) {
      alternative_phone
      phone_number
      phone_country_code
      phone_verified
    }
  }
`;

const INSERT_BOOKING_GQL = /* GraphQL */ `
  mutation BookInterview($obj: bookings_insert_input!) {
    insert_bookings_one(object: $obj) {
      id
      interview_date
      status
    }
  }
`;

/**
 * Notify the maid via the Ethiopian Maids in-app notifications table.
 * The mobile/web app polls this table and surfaces a push/banner.
 * Avoids the Meta-template requirement that blocks direct WhatsApp
 * first-touch to the maid.
 */
const NOTIFY_MAID_GQL = /* GraphQL */ `
  mutation NotifyMaid($obj: notifications_insert_input!) {
    insert_notifications_one(object: $obj) {
      id
    }
  }
`;

interface MaidLookupRow {
  id: string;
  first_name: string | null;
  full_name: string | null;
  nationality: string | null;
  country: string | null;
  availability_status: string | null;
}

/**
 * Resolve a maid by id OR by name. Returns at most 5 matches. The
 * caller decides whether to disambiguate or fail.
 */
async function resolveMaid(
  ctx: ToolContext,
  args: { maid_id?: string; maid_name?: string },
): Promise<MaidLookupRow[]> {
  const hasura = ensureHasura(ctx);
  if (args.maid_id) {
    const data = await hasura.query<{ maid_profiles_public: MaidLookupRow[] }>(
      RESOLVE_MAID_GQL,
      { where: { id: { _eq: args.maid_id } } },
    );
    return data.maid_profiles_public ?? [];
  }
  if (args.maid_name) {
    const n = args.maid_name.trim();
    if (!n) return [];
    const data = await hasura.query<{ maid_profiles_public: MaidLookupRow[] }>(
      RESOLVE_MAID_GQL,
      {
        where: {
          _or: [
            { first_name: { _ilike: `${n}%` } },
            { full_name: { _ilike: `%${n}%` } },
          ],
          availability_status: { _eq: 'available' },
        },
      },
    );
    return data.maid_profiles_public ?? [];
  }
  return [];
}

/**
 * Parse a human-friendly datetime string into an ISO timestamp.
 * Accepts: ISO 8601 ("2026-05-27T14:00:00Z"), or "tomorrow 2pm",
 * "today 4pm", "monday 10am", "in 2 hours". Returns null if unparseable.
 *
 * Kept deliberately simple — for production a real lib like chrono-node
 * would be more robust, but the LLM is encouraged to produce ISO format.
 */
function parseDatetime(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // Direct ISO try first.
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime()) && /^\d{4}-/.test(s)) {
    return direct.toISOString();
  }
  const lower = s.toLowerCase();
  const now = new Date();

  // "in N hours/minutes"
  const inMatch = lower.match(/^in\s+(\d+)\s*(hour|hr|h|min|minute|m)s?$/);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2];
    const mins = unit.startsWith('h') ? n * 60 : n;
    return new Date(now.getTime() + mins * 60_000).toISOString();
  }

  // "today/tomorrow [optional time]"
  const dayMatch = lower.match(/^(today|tomorrow)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (dayMatch) {
    const day = dayMatch[1];
    const hh = dayMatch[2] ? Number(dayMatch[2]) : 14; // default 2pm
    const mm = dayMatch[3] ? Number(dayMatch[3]) : 0;
    const ampm = dayMatch[4];
    let hour = hh;
    if (ampm === 'pm' && hh < 12) hour += 12;
    if (ampm === 'am' && hh === 12) hour = 0;
    const d = new Date(now);
    if (day === 'tomorrow') d.setDate(d.getDate() + 1);
    d.setHours(hour, mm, 0, 0);
    return d.toISOString();
  }

  return null;
}

/**
 * Generate a meeting URL for the interview. Uses Jitsi public rooms
 * (free, no API key required). A more robust setup would use Daily.co
 * or Whereby with rooms scoped to the booking id.
 */
function makeMeetingUrl(bookingId: string): string {
  const short = bookingId.replace(/-/g, '').slice(0, 12);
  return `https://meet.jit.si/EthiopianMaids-${short}`;
}

function formatScheduledTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const timeStr = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Dubai',
  });
  if (sameDay) return `today at ${timeStr}`;
  if (isTomorrow) return `tomorrow at ${timeStr}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Dubai' })} at ${timeStr}`;
}

export const bookInterview: ToolHandler = {
  name: 'book_interview',
  description:
    'Schedule a video interview between the sponsor (the WhatsApp customer) and a specific maid. ' +
    'Creates a booking in the database and generates a video meeting link. ' +
    'Call this when the customer says "book interview for [name]", "I want to interview X", etc. ' +
    'Pass maid_name (the first name from a card you already showed) — server resolves it. ' +
    'If the customer hasn\'t given a specific date/time yet, DO NOT call this tool — ask them first ' +
    '("When works for you? e.g. tomorrow 2pm").',
  parameters: {
    type: 'object',
    properties: {
      maid_name: {
        type: 'string',
        description: 'First name (or full name) of the maid to interview, e.g. "Grace". Server resolves to the canonical maid record.',
      },
      maid_id: {
        type: 'string',
        description: 'UUID of the maid (if known from a previous tool call). Preferred over maid_name if available.',
      },
      preferred_datetime: {
        type: 'string',
        description:
          'When the interview should happen. Accepts ISO 8601 ("2026-05-27T14:00:00Z"), or natural phrases the customer used ("tomorrow 2pm", "today 4pm", "in 2 hours"). Required — never guess a time without customer confirmation.',
      },
      duration_minutes: {
        type: 'number',
        description: 'Length of the interview in minutes. Default 30.',
      },
      notes: {
        type: 'string',
        description: 'Optional context for the ops team (e.g. "Sponsor wants live-in, 2 kids ages 4 and 6").',
      },
    },
    required: ['preferred_datetime'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args.maid_id && !args.maid_name) {
      return { error: 'Either maid_id or maid_name is required.' };
    }
    if (!args.preferred_datetime) {
      return { error: 'preferred_datetime is required. Ask the customer first if not given.' };
    }

    // 1. Resolve maid
    let matches: MaidLookupRow[];
    try {
      matches = await resolveMaid(ctx, {
        maid_id: args.maid_id as string | undefined,
        maid_name: args.maid_name as string | undefined,
      });
    } catch (e) {
      if (e instanceof HasuraError) return { error: `Hasura lookup failed: ${e.message}` };
      throw e;
    }
    if (matches.length === 0) {
      return {
        error: `Could not find an available maid matching "${args.maid_name ?? args.maid_id}". Re-run search_maids or ask the customer to clarify which candidate (first + last name).`,
      };
    }
    if (matches.length > 1) {
      const list = matches
        .map((m) => `${m.first_name || m.full_name} (${m.nationality || m.country || '?'})`)
        .join(', ');
      return {
        error: `Multiple maids match "${args.maid_name}": ${list}. Ask the customer which one (use first + last initial).`,
      };
    }
    const maid = matches[0];

    // 2. Parse datetime
    const isoTime = parseDatetime(String(args.preferred_datetime));
    if (!isoTime) {
      return {
        error: `Could not parse preferred_datetime "${args.preferred_datetime}". Use ISO 8601 (2026-05-27T14:00:00Z) or simple phrases like "tomorrow 2pm" / "today 4pm" / "in 2 hours".`,
      };
    }
    const scheduledAt = new Date(isoTime);
    if (scheduledAt.getTime() < Date.now() - 5 * 60_000) {
      return {
        error: `Time ${isoTime} is in the past. Ask the customer for a future time.`,
      };
    }
    const durationMinutes = Math.min(Math.max(Number(args.duration_minutes) || 30, 15), 120);

    // 3. Insert booking
    const hasura = ensureHasura(ctx);
    const sponsorNote = `Sponsor WhatsApp: ${ctx.contactPhone}${args.notes ? ` | Notes: ${args.notes}` : ''}`;
    let booking: { id: string; interview_date: string; status: string };
    // start_date is NOT NULL on bookings; we use the same date as the
    // interview (it's an interview booking, not yet a placement, so
    // start_date is provisional until they actually hire).
    const dateOnly = isoTime.slice(0, 10);
    try {
      const data = await hasura.query<{
        insert_bookings_one: { id: string; interview_date: string; status: string };
      }>(INSERT_BOOKING_GQL, {
        obj: {
          maid_id: maid.id,
          booking_type: 'interview',
          interview_type: 'video',
          interview_date: isoTime,
          start_date: dateOnly,
          status: 'pending_interview',
          duration_months: 0,
          notes: sponsorNote,
        },
      });
      booking = data.insert_bookings_one;
    } catch (e) {
      if (e instanceof HasuraError) return { error: `Failed to create booking: ${e.message}` };
      throw e;
    }

    // 4. Meeting URL
    const meetingUrl = makeMeetingUrl(booking.id);
    const timePretty = formatScheduledTime(isoTime);

    // 5. Notify the maid via Ethiopian Maids in-app notifications.
    // This avoids Meta's template requirement for first-touch WhatsApp.
    // Non-fatal — booking still succeeds if notification fails.
    let maidNotified = false;
    try {
      await hasura.query(NOTIFY_MAID_GQL, {
        obj: {
          user_id: maid.id, // maid_profiles.id IS the Firebase user_id
          type: 'interview_invitation',
          title: 'New interview request',
          message: `A sponsor has requested an interview ${timePretty}. Tap to join the video call.`,
          link: meetingUrl,
          action_url: meetingUrl,
          related_id: booking.id,
          related_type: 'booking',
          priority: 'high',
          read: false,
          delivery_channels: { in_app: true, push: true },
        },
      });
      maidNotified = true;
    } catch (e) {
      console.warn('[book_interview] maid notification insert failed:',
        e instanceof Error ? e.message : e);
    }

    // 6. Maid phone (for ops follow-up only — UI not yet displaying it)
    let maidPhone: string | null = null;
    try {
      const data = await hasura.query<{
        maid_profiles_by_pk: { alternative_phone: string | null; phone_number: string | null; phone_verified: boolean | null };
      }>(FETCH_MAID_PHONE_GQL, { id: maid.id });
      maidPhone = data.maid_profiles_by_pk?.alternative_phone || data.maid_profiles_by_pk?.phone_number || null;
    } catch {
      /* non-fatal */
    }

    // 7. Schedule sponsor reminders (T-60min and T-10min).
    // Only schedules reminders whose due_at is strictly in the future
    // (e.g. if booking is in 30min, only the T-10 reminder fires).
    const sponsorPhone = ctx.contactPhone;
    const reminderRows: Array<{
      user_id: string;
      conversation_id: string;
      recipient_phone: string;
      message_text: string;
      due_at: string;
      related_kind: string;
      related_id: string;
    }> = [];
    const T_MINUS_60 = new Date(scheduledAt.getTime() - 60 * 60_000);
    const T_MINUS_10 = new Date(scheduledAt.getTime() - 10 * 60_000);
    const now = Date.now();
    if (T_MINUS_60.getTime() > now + 60_000) {
      reminderRows.push({
        user_id: ctx.userId,
        conversation_id: ctx.conversationId,
        recipient_phone: sponsorPhone,
        message_text:
          `Reminder: your interview with ${maid.first_name || 'the candidate'} starts in 1 hour. ` +
          `Join link: ${meetingUrl}`,
        due_at: T_MINUS_60.toISOString(),
        related_kind: 'interview',
        related_id: booking.id,
      });
    }
    if (T_MINUS_10.getTime() > now + 60_000) {
      reminderRows.push({
        user_id: ctx.userId,
        conversation_id: ctx.conversationId,
        recipient_phone: sponsorPhone,
        message_text:
          `Starting in 10 minutes: your interview with ${maid.first_name || 'the candidate'}. ` +
          `Join now: ${meetingUrl}`,
        due_at: T_MINUS_10.toISOString(),
        related_kind: 'interview',
        related_id: booking.id,
      });
    }
    let remindersScheduled = 0;
    if (reminderRows.length > 0) {
      const { error: remErr } = await ctx.supabase
        .from('ai_scheduled_reminders')
        .insert(reminderRows);
      if (remErr) {
        console.warn('[book_interview] reminder insert failed:', remErr.message);
      } else {
        remindersScheduled = reminderRows.length;
      }
    }

    return {
      ok: true,
      booking_id: booking.id,
      maid_name: maid.first_name || maid.full_name,
      maid_id: maid.id,
      scheduled_at: isoTime,
      scheduled_at_friendly: timePretty,
      duration_minutes: durationMinutes,
      meeting_url: meetingUrl,
      maid_notified_in_app: maidNotified,
      maid_phone_on_file: !!maidPhone,
      reminders_scheduled: remindersScheduled,
      note:
        `Interview booked. Your FINAL text reply MUST include: (1) confirmation with maid name + scheduled time "${timePretty}", (2) the video link ${meetingUrl}, (3) mention that we've notified ${maid.first_name || 'the candidate'} ${maidNotified ? 'via her app' : '(our team will follow up with her)'} and that ${remindersScheduled > 0 ? `we'll send you a reminder ${remindersScheduled === 2 ? '1 hour and 10 minutes' : remindersScheduled === 1 ? '10 minutes' : ''} before` : 'the time is locked in'}. Keep it warm, 2-3 short lines, plain text only.`,
    };
  },
};

// ----------------------------------------------------------------
// reply_with_choices — ask a fixed-choice question as TAPPABLE options
// instead of making the customer type. ≤3 options render as Meta reply
// buttons; 4-10 render as a tap-to-expand list. The webhook already
// converts the customer's tap back into a normal text message (the
// option title), so the agent's next turn reads it like typed text.
// ----------------------------------------------------------------

export interface ChoiceMessage {
  kind: 'buttons' | 'list';
  bodyText: string;
  /** id/title pairs, titles truncated to the Meta limit for the kind. */
  options: Array<{ id: string; title: string }>;
  /** Only for kind='list': label of the tap-to-expand button. */
  buttonLabel?: string;
}

/**
 * Normalize a body + raw option strings into a sendable choice message.
 * Pure — exported for tests. Throws on 0 options; caps at 10; dedupes
 * empty strings; truncates titles to the per-kind Meta limit.
 */
export function buildChoiceMessage(bodyText: string, rawOptions: unknown[], buttonLabel?: string): ChoiceMessage {
  const body = String(bodyText ?? '').trim().slice(0, INTERACTIVE_LIMITS.bodyMaxLength);
  if (!body) throw new Error('body_text is required.');
  const titles: string[] = [];
  for (const o of rawOptions) {
    const t = String(o ?? '').trim();
    if (t && !titles.includes(t)) titles.push(t);
    if (titles.length >= INTERACTIVE_LIMITS.maxListRowsTotal) break;
  }
  if (titles.length === 0) throw new Error('options must contain 1-10 non-empty strings.');
  const kind: ChoiceMessage['kind'] = titles.length <= INTERACTIVE_LIMITS.maxButtons ? 'buttons' : 'list';
  const titleMax = kind === 'buttons'
    ? INTERACTIVE_LIMITS.buttonTitleMaxLength
    : INTERACTIVE_LIMITS.listRowTitleMaxLength;
  const options = titles.map((t, i) => ({ id: `opt_${i + 1}`, title: t.slice(0, titleMax) }));
  if (kind === 'buttons') return { kind, bodyText: body, options };
  const label = String(buttonLabel ?? '').trim().slice(0, INTERACTIVE_LIMITS.buttonTitleMaxLength) || 'Choose an option';
  return { kind, bodyText: body, options, buttonLabel: label };
}

export const replyWithChoices: ToolHandler = {
  name: 'reply_with_choices',
  description:
    'Ask the customer a question with TAPPABLE answer options instead of making them type. ' +
    'ALWAYS use this (in any stage) when your question has 2-10 fixed answers: yes/no offers, ' +
    '"already registered or new?", live-in vs live-out, picking a candidate or a time slot. ' +
    'Up to 3 options show as buttons; 4-10 as a tappable list. ' +
    'body_text IS the message the customer reads — put your full question there, in the conversation language. ' +
    'After this tool succeeds your turn is COMPLETE: output an EMPTY final reply, never repeat the question or options as text.',
  parameters: {
    type: 'object',
    properties: {
      body_text: {
        type: 'string',
        description: 'The question the customer reads above the options. Full sentence(s), conversation language, ≤1024 chars.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '2-10 short answer options, in the conversation language. Keep each under 20 characters (24 for 4+ options).',
      },
      button_label: {
        type: 'string',
        description: 'Only used when 4+ options (list format): label of the tap-to-open button, e.g. "View options". ≤20 chars. Default "Choose an option".',
      },
    },
    required: ['body_text', 'options'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!ctx.whatsapp) {
      return { error: 'WhatsApp send credentials are not available in this run. Ask the question in plain text instead.' };
    }
    let choice: ChoiceMessage;
    try {
      choice = buildChoiceMessage(
        String(args.body_text ?? ''),
        Array.isArray(args.options) ? args.options : [],
        typeof args.button_label === 'string' ? args.button_label : undefined,
      );
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }

    const to = sanitizePhoneForMeta(ctx.contactPhone);
    let messageId = '';
    try {
      if (choice.kind === 'buttons') {
        const r = await sendInteractiveButtons({
          phoneNumberId: ctx.whatsapp.phoneNumberId,
          accessToken: ctx.whatsapp.accessToken,
          to,
          bodyText: choice.bodyText,
          buttons: choice.options,
        });
        messageId = r.messageId;
      } else {
        const r = await sendInteractiveList({
          phoneNumberId: ctx.whatsapp.phoneNumberId,
          accessToken: ctx.whatsapp.accessToken,
          to,
          bodyText: choice.bodyText,
          buttonLabel: choice.buttonLabel ?? 'Choose an option',
          sections: [{ rows: choice.options }],
        });
        messageId = r.messageId;
      }
    } catch (e) {
      // Interactive sends can be rejected in rare account/region gaps —
      // degrade to plain text with numbered options rather than silence.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[reply_with_choices] interactive send failed, falling back to text:', msg);
      try {
        const fallback = `${choice.bodyText}\n${choice.options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}`;
        const r = await sendTextMessage({
          phoneNumberId: ctx.whatsapp.phoneNumberId,
          accessToken: ctx.whatsapp.accessToken,
          to,
          text: fallback,
        });
        messageId = r.messageId;
        await persistChoiceMessage(ctx, choice, messageId, 'text');
        return {
          ok: true,
          delivered_as: 'text_fallback',
          note: 'Options were sent as a numbered plain-text list (interactive rendering unavailable). Your final reply this turn MUST be empty.',
        };
      } catch (e2) {
        return { error: `Could not deliver the choices: ${e2 instanceof Error ? e2.message : String(e2)}` };
      }
    }

    await persistChoiceMessage(ctx, choice, messageId, 'interactive');
    return {
      ok: true,
      delivered_as: choice.kind,
      options_count: choice.options.length,
      note:
        'The question with tappable options is now in the customer\'s chat. Your turn is COMPLETE — ' +
        'output an EMPTY final reply. Do NOT repeat the question or the options as text.',
    };
  },
};

async function persistChoiceMessage(
  ctx: ToolContext,
  choice: ChoiceMessage,
  messageId: string,
  contentType: 'interactive' | 'text',
): Promise<void> {
  const persisted = `${choice.bodyText}\n${choice.options.map((o) => `▸ ${o.title}`).join('\n')}`;
  await ctx.supabase.from('messages').insert({
    conversation_id: ctx.conversationId,
    sender_type: 'agent',
    agent_kind: 'ai',
    content_type: contentType,
    content_text: persisted,
    message_id: messageId,
    status: 'sent',
  });
  await ctx.supabase
    .from('conversations')
    .update({
      last_message_text: choice.bodyText.slice(0, 200),
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', ctx.conversationId);
}

// ----------------------------------------------------------------
// save_match_alert — persist a saved search so the engagement cron
// (/api/ai/engagement/cron) can proactively message the customer when
// NEW matching maids (sponsor side) or jobs (maid side) appear. This
// is the two-sided matching loop: an empty search today becomes a
// WhatsApp notification the day the marketplace catches up.
// ----------------------------------------------------------------

export const saveMatchAlert: ToolHandler = {
  name: 'save_match_alert',
  description:
    'Save a match alert so we automatically message this customer on WhatsApp when NEW matches appear (checked continuously for 30 days). ' +
    'Use when search_maids or list_jobs returned nothing suitable AND the customer agreed to be notified, or when they explicitly ask to be told about future candidates/jobs. ' +
    'side="sponsor" watches for new maids matching their criteria; side="maid" watches for new job openings. ' +
    'Pass every criterion the customer gave — omitted fields mean "any". ' +
    'After it succeeds, confirm in ONE short sentence that we\'ll message them here the moment a match arrives.',
  parameters: {
    type: 'object',
    properties: {
      side: {
        type: 'string',
        enum: ['sponsor', 'maid'],
        description: 'sponsor = customer wants a maid (alert on new candidates). maid = customer wants a job (alert on new openings).',
      },
      language: {
        type: 'string',
        enum: ['en', 'ar', 'am'],
        description: 'Language for the future notification, matching the conversation. Default en.',
      },
      live_in: {
        type: 'boolean',
        description: 'Live-in (true) or live-out (false). Applies to both sides. Omit if not specified.',
      },
      languages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sponsor side: languages the maid should speak, e.g. ["English","Arabic"].',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sponsor side: required skills, e.g. ["childcare","cooking"].',
      },
      min_experience_years: {
        type: 'number',
        description: 'Sponsor side: minimum years of experience.',
      },
      max_salary_aed: {
        type: 'number',
        description: 'Sponsor side: maximum monthly salary in AED.',
      },
      country: {
        type: 'string',
        description: 'Maid side: destination country, e.g. "UAE".',
      },
      city: {
        type: 'string',
        description: 'Maid side: destination city, e.g. "Dubai".',
      },
      maid_experience_years: {
        type: 'number',
        description: 'Maid side: the maid\'s own years of experience (jobs requiring more are excluded).',
      },
    },
    required: ['side'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const side = (args.side === 'maid' ? 'maid' : 'sponsor') as MatchSide;
    const language = (['en', 'ar', 'am'].includes(String(args.language))
      ? String(args.language)
      : 'en') as AlertLanguage;
    const criteria = normalizeAlertCriteria(side, args);

    // One active alert per conversation + side: replace, don't stack.
    const { error: cancelErr } = await ctx.supabase
      .from('ai_match_alerts')
      .update({ status: 'cancelled' })
      .eq('conversation_id', ctx.conversationId)
      .eq('side', side)
      .eq('status', 'active');
    if (cancelErr) {
      return { error: `Could not replace the existing alert: ${cancelErr.message}` };
    }

    const { error: insertErr } = await ctx.supabase.from('ai_match_alerts').insert({
      user_id: ctx.userId,
      conversation_id: ctx.conversationId,
      recipient_phone: ctx.contactPhone,
      side,
      criteria,
      language,
    });
    if (insertErr) {
      return { error: `Could not save the alert: ${insertErr.message}` };
    }

    return {
      ok: true,
      side,
      criteria,
      note:
        'Alert saved — we check continuously for 30 days and will message the customer here as soon as a match arrives. ' +
        'Confirm in ONE short sentence (e.g. "Done! I\'ll message you here the moment a matching ' +
        (side === 'sponsor' ? 'candidate' : 'job') +
        ' becomes available 🌸"). Do not promise an exact date.',
    };
  },
};

// bookInterview is deliberately absent (2026-09-20): a video interview is
// an app entitlement — a registered sponsor on a package starts it from the
// candidate's profile there. Booking one from chat bypassed that. The
// handler stays for the ops tooling that may still call it directly.
export const ETHIOPIAN_MAIDS_TOOLS: ToolHandler[] = [
  searchMaids,
  getMaidProfile,
  sendMaidCards,
  sendAppDownloadCard,
  listJobs,
  getPricing,
  saveMatchAlert,
  replyWithChoices,
  escalateToHuman,
];
