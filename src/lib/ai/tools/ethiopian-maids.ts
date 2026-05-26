/**
 * Ethiopian Maids tool set — calls the user's Hasura GraphQL endpoint
 * for live data about available maids, pricing, and bookings.
 *
 * Implementation deliberately stays defensive about the underlying
 * Hasura schema: the agent's customer wires their own Hasura URL +
 * admin secret in Settings → AI Agent, and the tools query against
 * THAT. If a query fails (table missing, column renamed, no auth),
 * the error message bubbles back to the LLM as the tool result so
 * the model can decide to apologize, escalate to a human, or ask
 * a clarifying question instead of crashing the run.
 *
 * The GraphQL operations are intentionally generic — they target
 * `maids` / `service_pricing` tables with reasonable field names
 * (name, age, nationality, experience_years, languages, skills,
 * monthly_salary_aed, status, photo_url). If the customer's schema
 * uses different names, they should override these tools in their
 * fork rather than us trying to be psychic about every variant.
 */

import { makeHasuraClient, HasuraError } from './hasura';
import type { ToolHandler, ToolContext } from './registry';

function ensureHasura(ctx: ToolContext) {
  if (!ctx.hasuraUrl) {
    throw new Error(
      'Hasura URL is not configured. The user must set it in Settings → AI Agent before this tool can be used.',
    );
  }
  return makeHasuraClient(ctx.hasuraUrl, ctx.hasuraAdminSecret);
}

// ----------------------------------------------------------------
// search_maids
// ----------------------------------------------------------------
const SEARCH_MAIDS_GQL = /* GraphQL */ `
  query SearchMaids($where: maids_bool_exp!, $limit: Int!) {
    maids(
      where: $where
      limit: $limit
      order_by: [{ updated_at: desc }]
    ) {
      id
      name
      age
      nationality
      experience_years
      languages
      skills
      monthly_salary_aed
      status
      photo_url
      available_from
    }
  }
`;

export const searchMaids: ToolHandler = {
  name: 'search_maids',
  description:
    'Find available Ethiopian domestic workers (maids) matching the customer requirements. ' +
    'Returns up to 5 candidates with name, age, nationality, languages, skills, monthly salary in AED, and photo URL. ' +
    'Always use this BEFORE recommending any specific maid — never fabricate candidates.',
  parameters: {
    type: 'object',
    properties: {
      emirate: {
        type: 'string',
        description: 'UAE emirate the customer is in. One of: Dubai, Abu Dhabi, Sharjah, Ajman, Ras Al Khaimah, Fujairah, Umm Al Quwain.',
      },
      languages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Languages the maid should speak (e.g. ["English","Arabic"]).',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required skills, e.g. ["childcare","cooking","elderly_care","cleaning"].',
      },
      min_experience_years: { type: 'number', description: 'Minimum years of experience.' },
      max_monthly_salary_aed: { type: 'number', description: 'Maximum monthly salary the customer can pay, in AED.' },
      limit: { type: 'number', description: 'Max number of results to return. Default 5, cap 10.' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasura = ensureHasura(ctx);
    const where: Record<string, unknown> = { status: { _eq: 'available' } };
    if (typeof args.min_experience_years === 'number') {
      where.experience_years = { _gte: args.min_experience_years };
    }
    if (typeof args.max_monthly_salary_aed === 'number') {
      where.monthly_salary_aed = { _lte: args.max_monthly_salary_aed };
    }
    if (Array.isArray(args.languages) && args.languages.length > 0) {
      where.languages = { _has_keys_any: args.languages };
    }
    if (Array.isArray(args.skills) && args.skills.length > 0) {
      where.skills = { _has_keys_any: args.skills };
    }
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    try {
      const data = await hasura.query<{ maids: unknown[] }>(SEARCH_MAIDS_GQL, { where, limit });
      const maids = data.maids ?? [];
      return {
        count: maids.length,
        maids,
        note: maids.length === 0
          ? 'No maids match those criteria. Suggest broader criteria (e.g. loosen budget, fewer required skills).'
          : undefined,
      };
    } catch (e) {
      if (e instanceof HasuraError) {
        return { error: e.message, hint: 'Hasura query failed — the schema may differ. Consider escalating to a human.' };
      }
      throw e;
    }
  },
};

// ----------------------------------------------------------------
// get_maid_profile
// ----------------------------------------------------------------
const GET_MAID_GQL = /* GraphQL */ `
  query GetMaid($id: uuid!) {
    maids_by_pk(id: $id) {
      id
      name
      age
      nationality
      experience_years
      languages
      skills
      monthly_salary_aed
      status
      photo_url
      bio
      available_from
    }
  }
`;

export const getMaidProfile: ToolHandler = {
  name: 'get_maid_profile',
  description:
    'Get the full profile of a single maid by id. Use after search_maids when the customer asks for more detail on a specific candidate.',
  parameters: {
    type: 'object',
    properties: {
      maid_id: { type: 'string', description: 'UUID of the maid (from search_maids results).' },
    },
    required: ['maid_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasura = ensureHasura(ctx);
    const id = String(args.maid_id);
    try {
      const data = await hasura.query<{ maids_by_pk: unknown }>(GET_MAID_GQL, { id });
      if (!data.maids_by_pk) return { error: `No maid found with id ${id}.` };
      return { maid: data.maids_by_pk };
    } catch (e) {
      if (e instanceof HasuraError) return { error: e.message };
      throw e;
    }
  },
};

// ----------------------------------------------------------------
// get_pricing
// ----------------------------------------------------------------
const GET_PRICING_GQL = /* GraphQL */ `
  query GetPricing($service: String!) {
    service_pricing(where: { service_type: { _eq: $service } }) {
      service_type
      base_fee_aed
      monthly_salary_min_aed
      monthly_salary_max_aed
      contract_duration_months
      includes
      notes
    }
  }
`;

export const getPricing: ToolHandler = {
  name: 'get_pricing',
  description:
    'Return the current agency fees for a service type. ALWAYS call this before quoting any number to the customer; never invent prices.',
  parameters: {
    type: 'object',
    properties: {
      service_type: {
        type: 'string',
        enum: ['full_time_live_in', 'full_time_live_out', 'part_time', 'monthly', 'visa_processing'],
        description: 'Which service the customer is asking about.',
      },
    },
    required: ['service_type'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasura = ensureHasura(ctx);
    const service = String(args.service_type);
    try {
      const data = await hasura.query<{ service_pricing: unknown[] }>(GET_PRICING_GQL, { service });
      const rows = data.service_pricing ?? [];
      if (rows.length === 0) {
        return { error: `No pricing on file for service_type=${service}. Escalate to a human for a custom quote.` };
      }
      return { pricing: rows[0] };
    } catch (e) {
      if (e instanceof HasuraError) return { error: e.message };
      throw e;
    }
  },
};

// ----------------------------------------------------------------
// escalate_to_human (Supabase-backed, not Hasura)
// ----------------------------------------------------------------
export const escalateToHuman: ToolHandler = {
  name: 'escalate_to_human',
  description:
    'Hand the conversation off to a human agent. Use when: the customer is upset, asks for a refund, requests contract signing, raises a safety concern, or asks something you genuinely can\'t answer with the other tools. This pauses the AI for this conversation and tags it for human follow-up.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'One short sentence summarizing why human help is needed.',
      },
      urgent: {
        type: 'boolean',
        description: 'True for safety/abuse/trafficking concerns or active customer anger.',
      },
    },
    required: ['reason'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const reason = String(args.reason ?? 'human_requested').slice(0, 200);
    const urgent = Boolean(args.urgent);

    // 1. Pause AI for 24h on this conversation (effectively "off until a human re-engages").
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await ctx.supabase
      .from('conversations')
      .update({ ai_paused_until: until })
      .eq('id', ctx.conversationId);

    // 2. Best-effort tag for human triage. Tags are user-scoped; insert
    //    the tag once, then attach. Both inserts are idempotent enough
    //    that we let failures fall through as a soft tag (logged).
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
        // The schema may or may not allow tagging conversations directly;
        // best-effort use of contact_tags via the conversation's contact.
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
      note: 'AI is now paused for 24h on this conversation. Conversation tagged for human pickup. Send ONE final reply telling the customer a human agent will be with them shortly.',
    };
  },
};

export const ETHIOPIAN_MAIDS_TOOLS: ToolHandler[] = [
  searchMaids,
  getMaidProfile,
  getPricing,
  escalateToHuman,
];
