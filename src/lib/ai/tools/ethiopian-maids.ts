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
import { sendImageMessage } from '@/lib/whatsapp/meta-api';
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

export const searchMaids: ToolHandler = {
  name: 'search_maids',
  description:
    'Find available Ethiopian domestic workers (maids) matching the customer requirements. ' +
    'Returns up to 5 candidates with first name, age estimate, nationality, languages, skills, salary preference, and photo URL. ' +
    'Use this BEFORE recommending any specific maid — never fabricate candidates. ' +
    'Do NOT call this for greetings or chit-chat — only when the customer has expressed interest in hiring AND given at least one criterion (location, duties, or live-in preference).',
  parameters: {
    type: 'object',
    properties: {
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
      max_salary_aed: {
        type: 'number',
        description: 'Maximum monthly salary in AED the customer is willing to pay.',
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
    if (typeof args.max_salary_aed === 'number') {
      where.preferred_salary_max = { _lte: args.max_salary_aed };
    }
    // languages/skills are text[] (LIST in GraphQL). For "match ANY",
    // Postgres text[] supports overlap (&&) but Hasura's standard
    // operators don't expose it directly. We OR multiple _contains
    // checks (each _contains is "column @> [item]" — subset semantics
    // that returns true when the row's array contains the item).
    if (Array.isArray(args.languages) && args.languages.length > 0) {
      where._or = (where._or as unknown[] ?? []).concat(
        args.languages.map((l) => ({ languages: { _contains: [String(l)] } })),
      );
    }
    if (Array.isArray(args.skills) && args.skills.length > 0) {
      where._or = (where._or as unknown[] ?? []).concat(
        args.skills.map((s) => ({ skills: { _contains: [String(s)] } })),
      );
    }
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    try {
      const data = await hasura.query<{ maid_profiles_public: unknown[] }>(
        SEARCH_MAIDS_GQL,
        { where, limit },
      );
      const maids = data.maid_profiles_public ?? [];
      return {
        count: maids.length,
        maids,
        note:
          maids.length === 0
            ? 'No matching candidates with these criteria. Offer to broaden (drop salary cap, drop language/skill filter) or take their details.'
            : 'Recommend at most 2-3 of these candidates. Mention first name, nationality/country, experience years, key skills, and the salary range. If a photo_url exists, mention "I can share a photo if you\'d like".',
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
          ? 'No active jobs match these criteria. Offer to broaden the search (different city/country, drop experience filter) or take the maid\'s details so our team contacts her when a matching role opens.'
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
// escalate_to_human (Supabase-backed)
// ----------------------------------------------------------------
export const escalateToHuman: ToolHandler = {
  name: 'escalate_to_human',
  description:
    'Hand off to a human agent. Use when the customer is upset, asks for refunds, contract signing, raises safety concerns, or asks something the other tools genuinely cannot answer. ' +
    'Pauses the AI for 24h on this conversation and tags it for human pickup. After calling this, send ONE short reply telling the customer a human will be in touch.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'One short sentence on why a human is needed.' },
      urgent: { type: 'boolean', description: 'True for safety/abuse/trafficking concerns or active anger.' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const reason = String(args.reason ?? 'human_requested').slice(0, 200);
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

    return {
      ok: true,
      ai_paused_until: until,
      reason,
      urgent,
      note:
        'AI is now paused 24h on this conversation, tagged for human pickup. Send ONE final reply telling the customer a human agent will be with them shortly.',
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

function buildMaidCaption(m: MaidCardRow): string {
  const name = (m.first_name || m.full_name || 'Candidate').trim();
  const origin = m.nationality || m.country || 'Ethiopian';
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
  const avail = m.available_from ? `Available from ${m.available_from}` : 'Available now';

  const lines: string[] = [`*${name}* — ${origin}`, `🧰 ${expr}`];
  if (skills) lines.push(`✅ ${skills}`);
  if (langs) lines.push(`🗣️ ${langs}`);
  if (salary) lines.push(`💰 ${salary}${liveIn ? ' · ' + liveIn : ''}`);
  lines.push(`📅 ${avail}`);
  return lines.join('\n');
}

export const sendMaidCards: ToolHandler = {
  name: 'send_maid_cards',
  description:
    'Render 1–3 maid candidates as image+caption WhatsApp messages (cards), one per candidate. ' +
    'ALWAYS call this when presenting candidates to the customer — do NOT also list them in plain text. ' +
    'Each card shows the maid\'s photo, name, nationality, experience, top skills, languages, salary range, live-in preference, and availability. ' +
    'After this tool succeeds, your final text reply should be a short question like "Want details on any of them? Reply with the name." — DO NOT repeat the candidate details in your text.',
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
    const sent: Array<{ maid_id: string; ok: boolean; reason?: string }> = [];

    for (const m of ordered) {
      const caption = buildMaidCaption(m);
      if (!m.profile_photo_url) {
        // Fall back to text-only persist + skip Meta image send. Tell
        // the model so it can decide whether to mention the gap.
        sent.push({ maid_id: m.id, ok: false, reason: 'no_photo' });
        continue;
      }
      try {
        const r = await sendImageMessage({
          phoneNumberId: ctx.whatsapp.phoneNumberId,
          accessToken: ctx.whatsapp.accessToken,
          to,
          imageUrl: m.profile_photo_url,
          caption,
        });
        await ctx.supabase.from('messages').insert({
          conversation_id: ctx.conversationId,
          sender_type: 'agent',
          agent_kind: 'ai',
          content_type: 'image',
          content_text: caption,
          media_url: m.profile_photo_url,
          message_id: r.messageId,
          status: 'sent',
        });
        sent.push({ maid_id: m.id, ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[send_maid_cards] send failed for', m.id, msg);
        sent.push({ maid_id: m.id, ok: false, reason: msg });
      }
    }

    // Bump the conversation timestamp so the inbox sorts correctly.
    if (sent.some((s) => s.ok)) {
      await ctx.supabase
        .from('conversations')
        .update({
          last_message_text: `[${sent.filter((s) => s.ok).length} candidate photo(s)]`,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', ctx.conversationId);
    }

    return {
      sent,
      success_count: sent.filter((s) => s.ok).length,
      note:
        'Cards are now in the customer\'s WhatsApp. Your follow-up TEXT reply should be ONE short sentence ' +
        'inviting the next step (e.g. "Want details on any of them? Reply with the name"). ' +
        'Do NOT re-list the candidates in text — they already saw the cards.',
    };
  },
};

export const ETHIOPIAN_MAIDS_TOOLS: ToolHandler[] = [
  searchMaids,
  getMaidProfile,
  sendMaidCards,
  listJobs,
  getPricing,
  escalateToHuman,
];
