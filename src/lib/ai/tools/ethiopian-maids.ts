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
// search_maids — query maid_profiles
// ----------------------------------------------------------------
const SEARCH_MAIDS_GQL = /* GraphQL */ `
  query SearchMaids($where: maid_profiles_bool_exp!, $limit: Int!) {
    maid_profiles(
      where: $where
      limit: $limit
      order_by: [{ updated_at: desc }]
    ) {
      id
      first_name
      full_name
      country
      date_of_birth
      experience_years
      education_level
      coc_level
      availability_status
      available_from
      current_location
      introduction_video_url
      about_me
    }
  }
`;

export const searchMaids: ToolHandler = {
  name: 'search_maids',
  description:
    'Find available Ethiopian domestic workers (maids) matching the customer requirements. ' +
    'Returns up to 5 candidates with name, country, experience years, education, and current location. ' +
    'Use this BEFORE recommending any specific maid — never fabricate candidates. ' +
    'Do NOT call this for greetings or chit-chat — only when the customer has actually expressed interest in finding a maid.',
  parameters: {
    type: 'object',
    properties: {
      country: {
        type: 'string',
        description: 'Country the maid is currently in (e.g. "Ethiopia", "UAE"). Optional — leave blank to search all.',
      },
      min_experience_years: {
        type: 'number',
        description: 'Minimum years of experience.',
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
    if (typeof args.country === 'string' && args.country.trim()) {
      where.country = { _ilike: `%${args.country.trim()}%` };
    }
    if (typeof args.min_experience_years === 'number') {
      where.experience_years = { _gte: args.min_experience_years };
    }
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    try {
      const data = await hasura.query<{ maid_profiles: unknown[] }>(
        SEARCH_MAIDS_GQL,
        { where, limit },
      );
      const maids = data.maid_profiles ?? [];
      return {
        count: maids.length,
        maids,
        note:
          maids.length === 0
            ? 'No matching candidates. Suggest broader criteria (e.g. drop country filter) or escalate.'
            : 'Recommend at most 2-3 candidates. Mention their first name, country, and experience years. Do not share IDs or full names in chat.',
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
    maid_profiles_by_pk(id: $id) {
      id
      first_name
      full_name
      country
      date_of_birth
      experience_years
      education_level
      coc_level
      availability_status
      available_from
      current_location
      introduction_video_url
      about_me
      additional_notes
      contract_duration_preference
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
      const data = await hasura.query<{ maid_profiles_by_pk: unknown }>(GET_MAID_GQL, { id });
      if (!data.maid_profiles_by_pk) return { error: `No maid with id ${id}.` };
      return { maid: data.maid_profiles_by_pk };
    } catch (e) {
      if (e instanceof HasuraError) return { error: e.message };
      throw e;
    }
  },
};

// ----------------------------------------------------------------
// list_jobs — query agency_jobs
// ----------------------------------------------------------------
const LIST_JOBS_GQL = /* GraphQL */ `
  query ListJobs($where: agency_jobs_bool_exp!, $limit: Int!) {
    agency_jobs(
      where: $where
      limit: $limit
      order_by: [{ posted_date: desc }]
    ) {
      id
      title
      location
      job_type
      contract_duration_months
      salary_min
      salary_max
      currency
      live_in_required
      benefits
      requirements
      description
      status
    }
  }
`;

export const listJobs: ToolHandler = {
  name: 'list_jobs',
  description:
    'List active maid-placement jobs the agency has posted. Use when the customer (a maid) is looking for work, OR when a sponsor wants to see typical job postings.',
  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'City or emirate filter, e.g. "Dubai". Optional.',
      },
      live_in_required: {
        type: 'boolean',
        description: 'Only live-in jobs (true) / only live-out (false) / both (omit).',
      },
      limit: { type: 'number', description: 'Max results 1-10. Default 5.' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasura = ensureHasura(ctx);
    const where: Record<string, unknown> = {
      status: { _eq: 'open' },
    };
    if (typeof args.location === 'string' && args.location.trim()) {
      where.location = { _ilike: `%${args.location.trim()}%` };
    }
    if (typeof args.live_in_required === 'boolean') {
      where.live_in_required = { _eq: args.live_in_required };
    }
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    try {
      const data = await hasura.query<{ agency_jobs: unknown[] }>(LIST_JOBS_GQL, { where, limit });
      const jobs = data.agency_jobs ?? [];
      return {
        count: jobs.length,
        jobs,
        note: jobs.length === 0 ? 'No open jobs match. Suggest the customer leave their details.' : undefined,
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

export const ETHIOPIAN_MAIDS_TOOLS: ToolHandler[] = [
  searchMaids,
  getMaidProfile,
  listJobs,
  getPricing,
  escalateToHuman,
];
